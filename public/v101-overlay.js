(function () {
  if (window.__gvndV107Clean) return;
  window.__gvndV107Clean = true;

  if (window.AndroidBridge && window.AndroidBridge.isSmsVerified && window.AndroidBridge.isSmsVerified()) {
    localStorage.setItem("gvnd_sms_verified", "1");
  }

  let smsHandled = false;
  window.addEventListener("gvnd-sms-verified", function () {
    if (smsHandled) return;
    smsHandled = true;
    localStorage.setItem("gvnd_sms_verified", "1");
    window.dispatchEvent(new CustomEvent("gvnd-force-refresh"));
  });
})();
