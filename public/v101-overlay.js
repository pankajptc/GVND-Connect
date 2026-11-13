(function () {
  if (window.__gvndV109Final) return;
  window.__gvndV109Final = true;

  document.addEventListener("click", function () {
    try {
      const inp = document.querySelector('input[type="tel"], input[placeholder*="Mobile"], input[placeholder*="8700"]');
      if (inp && inp.value) {
        const d = String(inp.value).replace(/[^0-9]/g, "").slice(-10);
        if (d.length === 10) localStorage.setItem("gvnd_verified_phone", "+91" + d);
      }
    } catch (e) {}
  }, true);

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
