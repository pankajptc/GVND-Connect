(function () {
  if (window.__gvndV104Init) return;
  window.__gvndV104Init = true;

  function purgeFakeContactsAndSyncVerify() {
    const isSmsDone = localStorage.getItem("gvnd_sms_verified") === "1" ||
      (window.AndroidBridge && window.AndroidBridge.isSmsVerified && window.AndroidBridge.isSmsVerified());
    if (isSmsDone) localStorage.setItem("gvnd_sms_verified", "1");

    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.toLowerCase().includes("gvnd")) continue;
        const raw = localStorage.getItem(k);
        if (!raw || !raw.startsWith("{")) continue;
        const obj = JSON.parse(raw);
        if (isSmsDone) {
          if (obj.profile) {
            obj.profile.verified = true;
            obj.profile.smsVerified = true;
            obj.profile.trustLevel = Math.max(Number(obj.profile.trustLevel || 0), 1);
          }
          obj.verified = true;
          obj.smsVerified = true;
          obj.trustLevel = Math.max(Number(obj.trustLevel || 0), 1);
        }
        if (Array.isArray(obj.contacts)) {
          obj.contacts = obj.contacts.map(function (c) {
            const cleanDigits = String(c.phone || c.tel || "").replace(/[^0-9]/g, "").slice(-10);
            const cleanPhone = cleanDigits.length === 10 ? "+91" + cleanDigits : (c.phone || "");
            const badHandle = typeof c.handle === "string" && (c.handle.startsWith("@_") || c.handle.includes("_"));
            return Object.assign({}, c, {
              phone: cleanPhone,
              handle: badHandle ? "" : (c.handle || ""),
              onMesh: badHandle ? false : Boolean(c.handle)
            });
          });
        }
        localStorage.setItem(k, JSON.stringify(obj));
      }
    } catch (e) {}
  }

  purgeFakeContactsAndSyncVerify();

  window.addEventListener("gvnd-sms-verified", function () {
    localStorage.setItem("gvnd_sms_verified", "1");
    purgeFakeContactsAndSyncVerify();
    // Auto-close "Listening for Carrier Loopback" modal if open
    const btns = Array.from(document.querySelectorAll("button"));
    const cancelBtn = btns.find(function (b) { return (b.innerText || "").includes("Cancel Verification"); });
    if (cancelBtn) cancelBtn.click();
  });

  // Tap on "Not on Mesh • Tap to Invite" opens SMS Invite directly
  document.addEventListener("click", function (e) {
    const card = e.target && e.target.closest ? e.target.closest("div") : null;
    if (!card) return;
    const txt = card.innerText || "";
    if (txt.includes("Not on Mesh • Tap to Invite") && txt.length < 220) {
      const m = txt.match(/(\+91[0-9]{10})/);
      if (!m) return;
      e.stopPropagation();
      e.preventDefault();
      const hostUrl = (window.AndroidBridge && window.AndroidBridge.getHostUrl) ? window.AndroidBridge.getHostUrl() : "http://192.168.43.1:18081";
      const inviteMsg = "Namaste! Main GVND Connect (Offline Mesh Chat, Calls & Feeds) par hoon. Mere Hotspot se judne ke liye open karein: " + hostUrl;
      if (window.AndroidBridge && window.AndroidBridge.sendSms) {
        window.AndroidBridge.sendSms(m[1], inviteMsg);
      }
    }
  }, true);
})();
