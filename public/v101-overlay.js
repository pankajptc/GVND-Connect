(function () {
  if (window.__gvndV108Clean) return;
  window.__gvndV108Clean = true;

  function checkAndCloseLoopbackModal() {
    const ok = localStorage.getItem("gvnd_sms_verified") === "1" ||
      (window.AndroidBridge && window.AndroidBridge.isSmsVerified && window.AndroidBridge.isSmsVerified());
    if (!ok) return;
    localStorage.setItem("gvnd_sms_verified", "1");
    const btns = Array.from(document.querySelectorAll("button"));
    const cancelBtn = btns.find(function (b) { return (b.innerText || "").includes("Cancel Verification"); });
    if (cancelBtn) cancelBtn.click();
  }

  setInterval(checkAndCloseLoopbackModal, 1200);
  window.addEventListener("gvnd-sms-verified", function () {
    localStorage.setItem("gvnd_sms_verified", "1");
    checkAndCloseLoopbackModal();
  });
})();
