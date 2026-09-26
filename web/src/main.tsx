import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { registerSW } from "virtual:pwa-register";
import "./index.css";
import App from "./App";
import { AuthProvider } from "./lib/auth";
import { startAutoSync } from "./lib/offline";

registerSW({
  immediate: true,
  onRegisteredSW(_url, reg) {
    // 長時間開きっぱなしの端末でも1時間ごとに更新を確認
    if (reg) setInterval(() => void reg.update(), 60 * 60 * 1000);
  }
});
// 新バージョンが有効化されたら、入力中の画面を壊さないよう「画面が裏に回ったとき」に再読み込み
if ("serviceWorker" in navigator) {
  let pending = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (document.visibilityState === "hidden") location.reload();
    else pending = true;
  });
  document.addEventListener("visibilitychange", () => {
    if (pending && document.visibilityState === "hidden") location.reload();
  });
}
startAutoSync();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);
