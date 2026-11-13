(function () {
  if (window.__gvndV104Final) return;
  window.__gvndV104Final = true;

  if (window.AndroidBridge && window.AndroidBridge.isSmsVerified && window.AndroidBridge.isSmsVerified()) {
    localStorage.setItem("gvnd_sms_verified", "1");
  }

  window.addEventListener("gvnd-sms-verified", function () {
    localStorage.setItem("gvnd_sms_verified", "1");
    setTimeout(function () { window.location.reload(); }, 350);
  });
})();
