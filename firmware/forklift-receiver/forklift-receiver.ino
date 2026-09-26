/*
 * Intent-Trace 重機側 BLE 接近検知レシーバー（リファレンス実装）
 *
 * 対象: ESP32 (Arduino core 3.x) + NimBLE-Arduino 2.x + ArduinoJson 7.x
 *
 * 設計方針（事業企画書「物理安全層」）
 *  - 接近判定と警報/減速出力は この基板の中だけで完結 させる。
 *    Wi-Fi・クラウドが落ちていても安全機能は動き続ける（ネットワーク処理は別タスク）。
 *  - クラウドへは後から「接近ログ」だけをバッチ送信する（/api/device/proximity）。
 *  - バーチャルキー（/api/device/lock-state）は「起動許可」の補助表示・インターロック用。
 *    通信断時は安全側（起動不許可）に倒す。
 *
 * ⚠ 本コードはリファレンスであり、機能安全認証を受けたものではありません。
 *   車両の制動系へ接続する場合は、車両メーカーの指示と所定の安全評価を経てください。
 */
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <NimBLEDevice.h>
#include <ArduinoJson.h>
#include <time.h>
#include "config.h"

// ---------------- 接近状態（BLEタスクとメインループで共有） ----------------
struct Track {
  char id[16];          // "major:minor"
  float rssiEma;        // 平滑化RSSI
  int8_t txPower;       // 1m 時の RSSI（iBeacon measured power）
  uint32_t lastSeen;    // millis
  uint32_t enteredAt;   // 現在のレベルに入った時刻
  uint8_t level;        // 0=なし 1=注意 2=危険
  int8_t minRssi;
  float minDist;
};
static const int MAX_TRACKS = 16;
static Track tracks[MAX_TRACKS];
static portMUX_TYPE trackMux = portMUX_INITIALIZER_UNLOCKED;
static uint8_t beaconUuid[16];

// ---------------- ログのリングバッファ（送信待ち） ----------------
struct ProxEvent {
  char eventId[24];
  char bleId[16];
  int8_t rssi;
  float distanceM;
  uint8_t level;
  bool braked;
  uint64_t occurredAtMs;  // epoch ms（NTP未同期時は 0 → 送信時に補正）
  uint32_t durationMs;
  uint32_t millisAt;
};
static const int MAX_EVENTS = 64;
static ProxEvent events[MAX_EVENTS];
static int evHead = 0, evCount = 0;
static portMUX_TYPE evMux = portMUX_INITIALIZER_UNLOCKED;
static uint32_t evSeq = 0;

static volatile bool ignitionAllowed = false;

static float rssiToDistance(float rssi, int8_t txPower) {
  return powf(10.0f, ((float)txPower - rssi) / (10.0f * PATH_LOSS_N));
}

static void parseUuid(const char* s, uint8_t* out) {
  int j = 0;
  for (int i = 0; s[i] && j < 16; i++) {
    if (s[i] == '-') continue;
    char h[3] = {s[i], s[i + 1], 0};
    out[j++] = (uint8_t)strtoul(h, nullptr, 16);
    i++;
  }
}

static uint64_t nowEpochMs() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  if (tv.tv_sec < 1700000000) return 0;  // 未同期
  return (uint64_t)tv.tv_sec * 1000ULL + tv.tv_usec / 1000;
}

static void pushEvent(const Track& t, uint32_t durationMs, bool braked) {
  portENTER_CRITICAL(&evMux);
  int idx = (evHead + evCount) % MAX_EVENTS;
  if (evCount == MAX_EVENTS) evHead = (evHead + 1) % MAX_EVENTS;  // 古いものから捨てる
  else evCount++;
  ProxEvent& e = events[idx];
  snprintf(e.eventId, sizeof(e.eventId), "%08lx-%lu", (unsigned long)ESP.getEfuseMac(), (unsigned long)++evSeq);
  strncpy(e.bleId, t.id, sizeof(e.bleId));
  e.rssi = t.minRssi;
  e.distanceM = t.minDist;
  e.level = t.level;
  e.braked = braked;
  e.occurredAtMs = nowEpochMs();
  e.millisAt = millis();
  e.durationMs = durationMs;
  portEXIT_CRITICAL(&evMux);
}

// ---------------- BLE スキャン ----------------
class ScanCallbacks : public NimBLEScanCallbacks {
  void onResult(const NimBLEAdvertisedDevice* dev) override {
    std::string md = dev->getManufacturerData();
    // iBeacon: 4C 00 02 15 | UUID(16) | major(2) | minor(2) | txPower(1)
    if (md.size() != 25 || (uint8_t)md[0] != 0x4C || (uint8_t)md[1] != 0x00 || (uint8_t)md[2] != 0x02 || (uint8_t)md[3] != 0x15) return;
    if (memcmp(md.data() + 4, beaconUuid, 16) != 0) return;
    uint16_t major = ((uint8_t)md[20] << 8) | (uint8_t)md[21];
    uint16_t minor = ((uint8_t)md[22] << 8) | (uint8_t)md[23];
    int8_t tx = (int8_t)md[24];
    int rssi = dev->getRSSI();
    char id[16];
    snprintf(id, sizeof(id), "%u:%u", major, minor);

    portENTER_CRITICAL(&trackMux);
    int slot = -1, freeSlot = -1;
    for (int i = 0; i < MAX_TRACKS; i++) {
      if (tracks[i].id[0] && strcmp(tracks[i].id, id) == 0) { slot = i; break; }
      if (!tracks[i].id[0] && freeSlot < 0) freeSlot = i;
    }
    if (slot < 0 && freeSlot >= 0) {
      slot = freeSlot;
      memset(&tracks[slot], 0, sizeof(Track));
      strncpy(tracks[slot].id, id, sizeof(tracks[slot].id));
      tracks[slot].rssiEma = rssi;
      tracks[slot].minRssi = -127;
      tracks[slot].minDist = 99;
    }
    if (slot >= 0) {
      Track& t = tracks[slot];
      t.rssiEma = t.rssiEma * 0.6f + rssi * 0.4f;  // 指数平滑（誤検知と遅延のバランス）
      t.txPower = tx ? tx : -59;
      t.lastSeen = millis();
    }
    portEXIT_CRITICAL(&trackMux);
  }
};

// ---------------- 判定・出力（ローカル完結、50ms周期） ----------------
static void evaluate() {
  uint32_t now = millis();
  uint8_t worst = 0;
  portENTER_CRITICAL(&trackMux);
  for (int i = 0; i < MAX_TRACKS; i++) {
    Track& t = tracks[i];
    if (!t.id[0]) continue;
    bool lost = now - t.lastSeen > 2500;
    float d = rssiToDistance(t.rssiEma, t.txPower);
    uint8_t lvl = lost ? 0 : d <= DANGER_M ? 2 : d <= CAUTION_M ? 1 : 0;
    if (lvl > 0) {
      if ((int8_t)t.rssiEma > t.minRssi) t.minRssi = (int8_t)t.rssiEma;
      if (d < t.minDist) t.minDist = d;
    }
    if (lvl != t.level) {
      // レベル低下 or 離脱で1イベントとして確定（ピークのレベルで記録）
      if (t.level > 0 && lvl < t.level) {
        Track snap = t;
        portEXIT_CRITICAL(&trackMux);
        pushEvent(snap, now - snap.enteredAt, ENABLE_SLOWDOWN && snap.level == 2);
        portENTER_CRITICAL(&trackMux);
        t.minRssi = -127;
        t.minDist = 99;
      }
      if (lvl > t.level || lvl == 0) t.enteredAt = now;
      t.level = lvl;
    }
    if (lost) t.id[0] = 0;  // スロット解放
    if (t.level > worst) worst = t.level;
  }
  portEXIT_CRITICAL(&trackMux);

  // 警報出力
  bool blink = (now / 250) % 2;
  digitalWrite(PIN_BUZZER, worst == 2 ? HIGH : worst == 1 ? blink : LOW);
  digitalWrite(PIN_BEACON_LAMP, worst >= 1 ? HIGH : LOW);
#if ENABLE_SLOWDOWN
  digitalWrite(PIN_SLOWDOWN, worst == 2 ? HIGH : LOW);
#endif
#if ENABLE_IGNITION_INTERLOCK
  digitalWrite(PIN_IGNITION_OK, ignitionAllowed ? HIGH : LOW);
#endif
}

// ---------------- ネットワークタスク（安全機能とは独立） ----------------
static void netTask(void*) {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  configTime(9 * 3600, 0, "ntp.nict.jp", "pool.ntp.org");
  WiFiClientSecure tls;
  tls.setInsecure();  // TODO: 本番は setCACert() でルート証明書を固定
  uint32_t lastLock = 0;
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(2000));
    if (WiFi.status() != WL_CONNECTED) {
      ignitionAllowed = false;  // 通信断は安全側
      continue;
    }
    String auth = String("Device ") + DEVICE_CREDENTIAL;

    // 1) 接近ログのバッチ送信
    int n;
    portENTER_CRITICAL(&evMux);
    n = evCount > 20 ? 20 : evCount;
    ProxEvent batch[20];
    for (int i = 0; i < n; i++) batch[i] = events[(evHead + i) % MAX_EVENTS];
    portEXIT_CRITICAL(&evMux);
    if (n > 0) {
      JsonDocument doc;
      JsonArray arr = doc["events"].to<JsonArray>();
      uint64_t epochNow = nowEpochMs();
      for (int i = 0; i < n; i++) {
        JsonObject o = arr.add<JsonObject>();
        o["eventId"] = batch[i].eventId;
        o["bleId"] = batch[i].bleId;
        o["rssi"] = batch[i].rssi;
        o["distanceM"] = roundf(batch[i].distanceM * 10) / 10;
        o["level"] = batch[i].level == 2 ? "danger" : "caution";
        o["braked"] = batch[i].braked;
        uint64_t at = batch[i].occurredAtMs ? batch[i].occurredAtMs : (epochNow ? epochNow - (millis() - batch[i].millisAt) : 0);
        o["occurredAt"] = at;
        o["durationMs"] = batch[i].durationMs;
      }
      String body;
      serializeJson(doc, body);
      HTTPClient http;
      http.begin(tls, String(API_BASE) + "/api/device/proximity");
      http.addHeader("content-type", "application/json");
      http.addHeader("authorization", auth);
      int code = http.POST(body);
      http.end();
      if (code == 200) {
        portENTER_CRITICAL(&evMux);
        evHead = (evHead + n) % MAX_EVENTS;
        evCount -= n;
        portEXIT_CRITICAL(&evMux);
      }
    }

    // 2) バーチャルキー（起動許可）の取得
    if (millis() - lastLock > 5000) {
      lastLock = millis();
      HTTPClient http;
      http.begin(tls, String(API_BASE) + "/api/device/lock-state");
      http.addHeader("authorization", auth);
      int code = http.GET();
      if (code == 200) {
        JsonDocument doc;
        if (!deserializeJson(doc, http.getString())) ignitionAllowed = doc["ignition"] | false;
      } else {
        ignitionAllowed = false;
      }
      http.end();
    }
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_BEACON_LAMP, OUTPUT);
  pinMode(PIN_SLOWDOWN, OUTPUT);
  pinMode(PIN_IGNITION_OK, OUTPUT);
  digitalWrite(PIN_SLOWDOWN, LOW);
  digitalWrite(PIN_IGNITION_OK, LOW);
  parseUuid(BEACON_UUID, beaconUuid);

  NimBLEDevice::init("");
  NimBLEScan* scan = NimBLEDevice::getScan();
  scan->setScanCallbacks(new ScanCallbacks(), true);  // 重複広告も受け取る（RSSI追従のため）
  scan->setActiveScan(false);
  scan->setInterval(45);
  scan->setWindow(45);  // 連続スキャン
  scan->start(0, false, true);

  // ネットワークは別コア・低優先度で動かし、判定ループを阻害しない
  xTaskCreatePinnedToCore(netTask, "net", 12288, nullptr, 1, nullptr, 0);
}

void loop() {
  evaluate();
  delay(50);
}
