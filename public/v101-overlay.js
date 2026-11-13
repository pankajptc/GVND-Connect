(function () {
  if (window.__gvndV103Init) return;
  window.__gvndV103Init = true;

  function applyVerifiedToStorage() {
    localStorage.setItem("gvnd_sms_verified", "1");
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.toLowerCase().includes("gvnd")) continue;
        const raw = localStorage.getItem(k);
        if (!raw || !raw.startsWith("{")) continue;
        const obj = JSON.parse(raw);
        if (obj.profile) {
          obj.profile.verified = true;
          obj.profile.smsVerified = true;
          obj.profile.trustLevel = Math.max(Number(obj.profile.trustLevel || 0), 1);
          obj.profile.level = Math.max(Number(obj.profile.level || 0), 1);
        }
        if (typeof obj.trustLevel !== "undefined") obj.trustLevel = Math.max(Number(obj.trustLevel || 0), 1);
        obj.verified = true;
        obj.smsVerified = true;
        if (Array.isArray(obj.contacts)) {
          obj.contacts = obj.contacts.map(function (c) {
            if (c && typeof c.handle === "string" && (c.handle.startsWith("@_91_") || c.handle.startsWith("@_"))) {
              return Object.assign({}, c, { handle: "", onMesh: false });
            }
            return c;
          });
        }
        localStorage.setItem(k, JSON.stringify(obj));
      }
    } catch (e) {}
  }

  if (localStorage.getItem("gvnd_sms_verified") === "1" || (window.AndroidBridge && window.AndroidBridge.isSmsVerified && window.AndroidBridge.isSmsVerified())) {
    applyVerifiedToStorage();
  }

  let handled = false;
  window.addEventListener("gvnd-sms-verified", function () {
    if (handled) return;
    handled = true;
    applyVerifiedToStorage();
    window.dispatchEvent(new CustomEvent("gvnd-state-sync"));
  });

  // Invite hook when tapping any non-mesh contact (using local Hotspot URL for now)
  document.addEventListener("click", function (e) {
    const el = e.target && e.target.closest ? e.target.closest("div, button") : null;
    if (!el) return;
    const txt = el.innerText || "";
    if (txt.includes("Not on Mesh") && txt.length < 180) {
      const m = txt.match(/(\+91[0-9]{10}|[6-9][0-9]{9})/);
      const num = m ? m[1] : "";
      if (!num) return;
      e.stopPropagation();
      e.preventDefault();
      const hostUrl = (window.AndroidBridge && window.AndroidBridge.getHostUrl) ? window.AndroidBridge.getHostUrl() : "http://192.168.43.1:18081";
      const inviteMsg = "Namaste! Main GVND Connect (Offline Mesh Chat, Calls & Feeds) par hoon. Mere Hotspot se judne ke liye open karein: " + hostUrl;
      if (window.AndroidBridge && window.AndroidBridge.sendSms) {
        window.AndroidBridge.sendSms(num, inviteMsg);
      } else if (navigator.share) {
        navigator.share({ title: "Join GVND Connect", text: inviteMsg }).catch(function () {});
      }
    }
  }, true);
})();
