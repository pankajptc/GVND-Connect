(function () {
  if (window.__gvndV110Master) return;
  window.__gvndV110Master = true;

  // 1. Intercept click on any non-mesh contact card -> launch SMS Invite directly, block chat open
  document.addEventListener("click", function (e) {
    const target = e.target;
    if (!target || !target.closest) return;
    if (target.closest('button[aria-label*="Delete"], button[title*="Delete"], svg.lucide-trash, svg.lucide-trash-2')) return;
    const card = target.closest("div, li, button");
    if (!card) return;
    const txt = card.innerText || "";
    if (txt.includes("Not on Mesh") && txt.length < 220) {
      const m = txt.match(/(\+91[0-9]{10})/);
      if (!m) return;
      e.stopImmediatePropagation();
      e.stopPropagation();
      e.preventDefault();
      const hostUrl = (window.AndroidBridge && window.AndroidBridge.getHostUrl) ? window.AndroidBridge.getHostUrl() : "http://192.168.43.1:18081";
      const msg = "Namaste! Main GVND Connect (Offline Mesh Chat, Calls & Feeds) par hoon. Mere Hotspot se judne ke liye open karein: " + hostUrl;
      if (window.AndroidBridge && window.AndroidBridge.sendSms) {
        window.AndroidBridge.sendSms(m[1], msg);
      } else {
        window.location.href = "sms:" + m[1] + "?body=" + encodeURIComponent(msg);
      }
    }
  }, true);

  // 2. Sync SMS Verification cleanly without reload/blink
  function syncVerifyState() {
    const ok = localStorage.getItem("gvnd_sms_verified") === "1" ||
      (window.AndroidBridge && window.AndroidBridge.isSmsVerified && window.AndroidBridge.isSmsVerified());
    if (!ok) return;
    localStorage.setItem("gvnd_sms_verified", "1");
    const btns = Array.from(document.querySelectorAll("button"));
    const cancelBtn = btns.find(function (b) { return (b.innerText || "").includes("Cancel Verification"); });
    if (cancelBtn) cancelBtn.click();
  }
  setInterval(syncVerifyState, 1200);
  window.addEventListener("gvnd-sms-verified", syncVerifyState);
})();
