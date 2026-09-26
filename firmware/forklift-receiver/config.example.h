// config.h としてコピーして編集（config.h は git 管理外）
#pragma once

// --- Wi-Fi / API（ログ送信用。警報・停止の判断には一切使わない） ---
#define WIFI_SSID        "your-ssid"
#define WIFI_PASSWORD    "your-password"
#define API_BASE         "https://intent-trace.example.com"
#define DEVICE_CREDENTIAL "dev_XXXXXXXXXXXX.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"  // 管理画面「IoTデバイス」で発行

// --- 作業員が携帯する BLE タグ（iBeacon）の UUID ---
#define BEACON_UUID      "5A7E1D00-17E7-4A11-9C3B-5752414944AA"

// --- 距離しきい値（現場で必ず実測してキャリブレーションすること） ---
#define CAUTION_M        5.0f   // 注意: ブザー断続
#define DANGER_M         2.0f   // 危険: ブザー連続 + 回転灯
#define PATH_LOSS_N      2.2f   // 環境係数（屋内 2.0〜3.0）

// --- 出力ピン ---
#define PIN_BUZZER       25
#define PIN_BEACON_LAMP  26
#define PIN_SLOWDOWN     27     // フェーズ3: 車両側の減速/停止入力へ（安全リレー経由）。既定は無効
#define ENABLE_SLOWDOWN  0      // 1 にする前に、車両メーカー・安全担当者の承認と機能安全評価を必ず行うこと
#define PIN_IGNITION_OK  14     // プランB: バーチャルキー（起動許可）表示/インターロック出力
#define ENABLE_IGNITION_INTERLOCK 0
