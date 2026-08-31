#include "hardware_manager.h"
#include <Adafruit_NeoPixel.h>
#include <Preferences.h>
#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>

static const char *TAG = "HardwareManager";

static Adafruit_NeoPixel strip(1, NEOPIXEL_PIN, NEO_GRB + NEO_KHZ800);
static SemaphoreHandle_t hwMutex = NULL;
static TaskHandle_t hwTaskHandle = NULL;

static OperatingMode currentHwMode = MODE_SELECTOR;
static bool buzzerEnabled = true;

struct Note {
    uint16_t freq;       // Hz (0 = rest/silence)
    uint16_t durationMs; // Duration in ms
};

static Note activeJingle[8];
static uint8_t jingleLength = 0;
static uint8_t jingleIndex = 0;
static uint32_t noteStartTime = 0;
static bool jinglePlaying = false;

static bool geigerLocked = false;
static int geigerRssi = -90;
static bool geigerTriggerImmediate = false;
static uint32_t lastGeigerClickTime = 0;
static bool geigerClickActive = false;
static uint32_t geigerClickStartTime = 0;

static bool flashActive = false;
static uint8_t flashR = 0, flashG = 0, flashB = 0;
static uint32_t flashEndTime = 0;

static bool alarmActive = false;
static uint32_t alarmEndTime = 0;

// Calculate Geiger click pitch and repetition interval from RSSI (-95 to -30 dBm)
static inline void calculateGeigerParams(int rssi, uint16_t &freqOut, uint32_t &intervalOut) {
    int clampedRssi = rssi;
    if (clampedRssi < -95) clampedRssi = -95;
    if (clampedRssi > -30) clampedRssi = -30;

    float t = (float)(clampedRssi - (-95)) / (float)(-30 - (-95)); // 0.0 (weak) to 1.0 (strong)
    freqOut = 500 + (uint16_t)(t * 2000.0f);     // 500 Hz to 2500 Hz
    intervalOut = 1000 - (uint32_t)(t * 920.0f); // 1000 ms down to 80 ms
}

static void loadJingleNotes(OperatingMode mode) {
    jingleIndex = 0;
    noteStartTime = 0;

    switch (mode) {
        case MODE_SELECTOR:
            activeJingle[0] = {523, 80};  // C5
            activeJingle[1] = {659, 80};  // E5
            activeJingle[2] = {784, 120}; // G5
            jingleLength = 3;
            break;
        case MODE_BEACON_BANDIT:
            activeJingle[0] = {880, 60};   // A5
            activeJingle[1] = {1175, 60};  // D6
            activeJingle[2] = {1760, 120}; // A6
            jingleLength = 3;
            break;
        case MODE_WATCHERS_WATCH:
            activeJingle[0] = {600, 70};
            activeJingle[1] = {900, 70};
            activeJingle[2] = {1200, 120};
            jingleLength = 3;
            break;
        case MODE_SKY_SWEEPER:
            activeJingle[0] = {1000, 50};
            activeJingle[1] = {1400, 50};
            activeJingle[2] = {1800, 50};
            activeJingle[3] = {2400, 100};
            jingleLength = 4;
            break;
        case MODE_SHADOW:
            // Descending, watchful — you're the one being followed.
            activeJingle[0] = {1200, 70};
            activeJingle[1] = {900, 70};
            activeJingle[2] = {600, 140};
            jingleLength = 3;
            break;
        default:
            jingleLength = 0;
            break;
    }
    jinglePlaying = (jingleLength > 0);
}

static void HardwareManagerTask(void *pvParameters) {
    (void)pvParameters;
    uint32_t lastPixelColor = 0xFFFFFFFF;

    for (;;) {
        if (hwMutex != NULL && xSemaphoreTake(hwMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
            uint32_t now = millis();

            // 1. Process Jingle Audio
            if (jinglePlaying) {
                if (noteStartTime == 0) {
                    noteStartTime = now;
                    if (activeJingle[jingleIndex].freq > 0 && buzzerEnabled) {
                        tone(BUZZER_PIN, activeJingle[jingleIndex].freq);
                    } else {
                        noTone(BUZZER_PIN);
                    }
                } else if (now - noteStartTime >= activeJingle[jingleIndex].durationMs) {
                    noTone(BUZZER_PIN);
                    jingleIndex++;
                    if (jingleIndex < jingleLength) {
                        noteStartTime = now;
                        if (activeJingle[jingleIndex].freq > 0 && buzzerEnabled) {
                            tone(BUZZER_PIN, activeJingle[jingleIndex].freq);
                        }
                    } else {
                        jinglePlaying = false;
                        jingleIndex = 0;
                        jingleLength = 0;
                        noTone(BUZZER_PIN);
                    }
                }
            }

            // 2. Process Geiger Counter Audio (when no jingle is active)
            if (!jinglePlaying) {
                if (geigerClickActive) {
                    if (now - geigerClickStartTime >= 25) { // 25ms Geiger click duration
                        noTone(BUZZER_PIN);
                        geigerClickActive = false;
                    }
                }

                if (geigerLocked) {
                    uint16_t gFreq;
                    uint32_t gInterval;
                    calculateGeigerParams(geigerRssi, gFreq, gInterval);

                    if (geigerTriggerImmediate || (now - lastGeigerClickTime >= gInterval)) {
                        geigerTriggerImmediate = false;
                        geigerClickActive = true;
                        geigerClickStartTime = now;
                        lastGeigerClickTime = now;

                        if (buzzerEnabled) {
                            tone(BUZZER_PIN, gFreq);
                        }
                        // Visual Geiger pulse flash
                        flashActive = true;
                        flashR = 255;
                        flashG = 0;
                        flashB = 128;
                        flashEndTime = now + 25;
                    }
                } else if (!geigerClickActive && !alarmActive) {
                    noTone(BUZZER_PIN);
                }
            }

            // 2.5 Process Alarm Audio (overrides Geiger)
            if (alarmActive) {
                if (now < alarmEndTime) {
                    if (buzzerEnabled) {
                        uint32_t t = now % 300;
                        tone(BUZZER_PIN, t < 150 ? 2500 : 1800); // Police siren style
                    }
                    
                    // Strobe red/blue
                    flashActive = true;
                    uint32_t ft = now % 200;
                    if (ft < 100) {
                        flashR = 255; flashG = 0; flashB = 0;
                    } else {
                        flashR = 0; flashG = 0; flashB = 255;
                    }
                    flashEndTime = now + 10; 
                } else {
                    alarmActive = false;
                    noTone(BUZZER_PIN);
                }
            }

            // 3. Render NeoPixel Status Indicator
            uint32_t currentPixelColor = strip.Color(0, 0, 0);

            if (flashActive) {
                if (now < flashEndTime) {
                    currentPixelColor = strip.Color(flashR, flashG, flashB);
                } else {
                    flashActive = false;
                }
            }

            if (!flashActive) {
                switch (currentHwMode) {
                    case MODE_SELECTOR: {
                        uint32_t t = now % 1000;
                        if (t < 200) currentPixelColor = strip.Color(0, 200, 255); // Cyan blink
                        break;
                    }
                    case MODE_BEACON_BANDIT: {
                        uint32_t t = now % 1200;
                        if (geigerLocked) {
                            if (t < 300) currentPixelColor = strip.Color(255, 0, 128); // Magenta lock pulse
                        } else {
                            if (t < 100 || (t >= 220 && t < 320)) {
                                currentPixelColor = strip.Color(255, 165, 0); // Amber double blink
                            }
                        }
                        break;
                    }
                    case MODE_WATCHERS_WATCH: {
                        uint32_t t = now % 800;
                        if (t < 150) currentPixelColor = strip.Color(0, 255, 100); // Green blink
                        break;
                    }
                    case MODE_SKY_SWEEPER: {
                        uint32_t t = now % 600;
                        if (t < 80) currentPixelColor = strip.Color(120, 0, 255); // Violet strobe
                        break;
                    }
                    case MODE_SHADOW: {
                        uint32_t t = now % 2000;
                        // Slow white "sweep" breath — passive, patient watching
                        if (t < 500) {
                            uint8_t v = (uint8_t)((t * 180) / 500);
                            currentPixelColor = strip.Color(v, v, v);
                        } else if (t < 1000) {
                            uint8_t v = (uint8_t)(180 - (((t - 500) * 180) / 500));
                            currentPixelColor = strip.Color(v, v, v);
                        }
                        break;
                    }
                }
            }

            if (currentPixelColor != lastPixelColor) {
                strip.setPixelColor(0, currentPixelColor);
                strip.show();
                lastPixelColor = currentPixelColor;
            }

            xSemaphoreGive(hwMutex);
        }

        vTaskDelay(pdMS_TO_TICKS(15));
    }
}

void hardwareInit() {
    if (hwMutex == NULL) {
        hwMutex = xSemaphoreCreateMutex();
    }

    pinMode(BUZZER_PIN, OUTPUT);
    digitalWrite(BUZZER_PIN, LOW);

    strip.begin();
    strip.setBrightness(50);
    strip.setPixelColor(0, strip.Color(0, 200, 255));
    strip.show();

    Preferences prefs;
    if (prefs.begin("ouispy-bz", true)) {
        buzzerEnabled = prefs.getBool("on", true);
        prefs.end();
    } else {
        buzzerEnabled = true;
    }
    ESP_LOGI(TAG, "Hardware Manager initialized. Buzzer %s", buzzerEnabled ? "ENABLED" : "MUTED");

    xTaskCreatePinnedToCore(
        HardwareManagerTask,
        "HardwareTask",
        3072,
        NULL,
        2,
        &hwTaskHandle,
        1
    );
}

void hardwareSetMode(OperatingMode mode) {
    if (hwMutex != NULL && xSemaphoreTake(hwMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        currentHwMode = mode;
        loadJingleNotes(mode);
        if (mode != MODE_BEACON_BANDIT) {
            geigerLocked = false;
        }
        xSemaphoreGive(hwMutex);
        ESP_LOGI(TAG, "Hardware mode updated to: %s", getModeName(mode));
    }
}

void playModeJingle(OperatingMode mode) {
    if (hwMutex != NULL && xSemaphoreTake(hwMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        loadJingleNotes(mode);
        xSemaphoreGive(hwMutex);
    }
}

void playConnectionChirp() {
    if (hwMutex != NULL && xSemaphoreTake(hwMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        jingleIndex = 0;
        noteStartTime = 0;
        activeJingle[0] = {1500, 100};
        activeJingle[1] = {2500, 150};
        jingleLength = 2;
        jinglePlaying = true;
        xSemaphoreGive(hwMutex);
    }
}

void playDisconnectionChirp() {
    if (hwMutex != NULL && xSemaphoreTake(hwMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        jingleIndex = 0;
        noteStartTime = 0;
        activeJingle[0] = {2500, 150};
        activeJingle[1] = {1500, 100};
        jingleLength = 2;
        jinglePlaying = true;
        xSemaphoreGive(hwMutex);
    }
}

void updateGeigerRssi(int rssi) {
    if (hwMutex != NULL && xSemaphoreTake(hwMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
        geigerLocked = true;
        geigerRssi = rssi;
        xSemaphoreGive(hwMutex);
    }
}

void setGeigerTargetLock(bool locked, int initialRssi) {
    if (hwMutex != NULL && xSemaphoreTake(hwMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
        geigerLocked = locked;
        if (locked) {
            geigerRssi = initialRssi;
        } else {
            noTone(BUZZER_PIN);
        }
        xSemaphoreGive(hwMutex);
        ESP_LOGI(TAG, "Geiger target lock state: %s (RSSI: %d)", locked ? "LOCKED" : "UNLOCKED", initialRssi);
    }
}

void setBuzzerEnabled(bool enabled) {
    if (hwMutex != NULL && xSemaphoreTake(hwMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
        buzzerEnabled = enabled;
        if (!enabled) {
            noTone(BUZZER_PIN);
        }
        xSemaphoreGive(hwMutex);
        ESP_LOGI(TAG, "Buzzer set to: %s", enabled ? "ENABLED" : "MUTED");
    }
}

bool isBuzzerEnabled() {
    bool enabled = true;
    if (hwMutex != NULL && xSemaphoreTake(hwMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
        enabled = buzzerEnabled;
        xSemaphoreGive(hwMutex);
    }
    return enabled;
}

void triggerLedFlash(uint8_t r, uint8_t g, uint8_t b, uint32_t durationMs) {
    if (hwMutex != NULL && xSemaphoreTake(hwMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
        flashActive = true;
        flashR = r;
        flashG = g;
        flashB = b;
        flashEndTime = millis() + durationMs;
        xSemaphoreGive(hwMutex);
    }
}

void triggerAlarm() {
    if (hwMutex != NULL && xSemaphoreTake(hwMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
        // Only trigger if not already playing an alarm to prevent infinite sustain
        if (!alarmActive) {
            alarmActive = true;
            alarmEndTime = millis() + 1500; // 1.5 second alarm
        }
        xSemaphoreGive(hwMutex);
    }
}

void triggerWarning() {
    if (hwMutex != NULL && xSemaphoreTake(hwMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
        if (!alarmActive) { // Don't override a full alarm
            jingleIndex = 0;
            noteStartTime = 0;
            activeJingle[0] = {800, 150};
            activeJingle[1] = {600, 200};
            jingleLength = 2;
            jinglePlaying = true;
            flashActive = true;
            flashR = 255; flashG = 165; flashB = 0; // Orange
            flashEndTime = millis() + 500;
        }
        xSemaphoreGive(hwMutex);
    }
}
