(function () {
  if (window.__gvndV101Loaded) return;
  window.__gvndV101Loaded = true;

  // 1. Native APK API Routing + Dynamic Hotspot IP Injection + Browser HTTPS Warning Popup
  const isApk = location.protocol === "https:" && location.hostname === "localhost";
  let targetHost = localStorage.getItem("gvnd_mesh_host") || "http://127.0.0.1:18081";
  let myLocalIp = "";
  const origFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (isApk && url.startsWith("/api/")) {
      return origFetch(targetHost + url, init).catch(() => origFetch("http://127.0.0.1:18081" + url, init));
    }
    return origFetch(input, init);
  };

  // Browser HTTPS Popup when accessing via non-HTTPS LAN IP (e.g. http://192.168.43.1:18081)
  if (!isApk && location.protocol === "http:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    const httpsLink = "https://" + location.hostname + ":18443" + location.pathname;
    const banner = document.createElement("div");
    banner.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.86);display:flex;align-items:center;justify-content:center;padding:20px;";
    banner.innerHTML = `
      <div style="background:#0f1c24;border:1px solid #10b981;border-radius:16px;padding:20px;max-width:360px;color:#fff;font-family:sans-serif;text-align:center;">
        <h3 style="margin:0 0 8px;color:#34d399;font-size:18px;">HTTPS Mode Zaroori Hai</h3>
        <p style="margin:0 0 14px;font-size:13px;color:#cbd5e1;line-height:1.5;">
          Browser par Video Call, Camera, Mic aur Live Stream chalane ke liye सुरक्षित <b>HTTPS</b> link kholna zaroori hai.
        </p>
        <a href="${httpsLink}" style="display:block;background:#10b981;color:#042f2e;font-weight:700;padding:12px;border-radius:10px;text-decoration:none;margin-bottom:10px;">
          HTTPS Par Jayein (${httpsLink})
        </a>
        <button id="gvnd-dismiss-https" style="background:transparent;border:1px solid #334155;color:#94a3b8;padding:8px 14px;border-radius:8px;font-size:12px;">
          Abhi HTTP Par Rahein
        </button>
      </div>`;
    document.body.appendChild(banner);
    document.getElementById("gvnd-dismiss-https").onclick = () => banner.remove();
  }

  // Sync Hotspot IP & Auto-Discovery every 2.5s
  setInterval(async () => {
    try {
      const base = isApk ? "http://127.0.0.1:18081" : "";
      const r = await origFetch(base + "/api/info");
      const d = await r.json();
      if (d.localIp && d.localIp !== "127.0.0.1") myLocalIp = d.localIp;
      if (isApk && d.discoveredHostIp && !d.localIp.endsWith(".1")) {
        targetHost = "http://" + d.discoveredHostIp + ":18081";
        localStorage.setItem("gvnd_mesh_host", targetHost);
      }
      // Replace any leftover https://localhost text in Hotspot Modal with Real Hotspot HTTP + HTTPS URLs
      document.querySelectorAll("*").forEach((el) => {
        if (el.children.length === 0 && el.textContent && el.textContent.trim() === "https://localhost") {
          const ip = myLocalIp || "192.168.43.1";
          el.textContent = `HTTP: http://${ip}:18081  |  HTTPS: https://${ip}:18443`;
        }
      });
    } catch (e) {}
  }, 2500);

  // 2. Self-SMS Verification Auto-Complete Listener
  window.addEventListener("gvnd-sms-verified", () => {
    try {
      const keys = Object.keys(localStorage);
      for (const k of keys) {
        if (k.includes("gvnd") || k.includes("mesh")) {
          const val = localStorage.getItem(k);
          if (val && val.includes("verification")) {
            const parsed = JSON.parse(val);
            if (parsed.me) {
              parsed.me.verification = { verified: true, type: "self_sms", level: 1, phone: parsed.me.verification?.phone || "Verified" };
              localStorage.setItem(k, JSON.stringify(parsed));
            }
          }
        }
      }
      alert("✅ Self-SMS Verify Ho Gaya! App refresh ho raha hai.");
      location.reload();
    } catch (e) {}
  });

  // 3. Level-2 360p Live Stream Engine (100MB Auto-Post & Seamless Continuation)
  window.addEventListener("gvnd-open-live", async (ev) => {
    const level = (ev.detail && ev.detail.level) || 0;
    if (level < 2) {
      alert("⚠️ Live Stream sirf Level 2 Verified users ke liye उपलब्ध hai. Pehle 3 peers se vouch karwake Level 2 complete karein.");
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } },
        audio: true
      });
    } catch (err) {
      alert("Camera/Mic permission allow karein ya HTTPS mode use karein.");
      return;
    }

    const modal = document.createElement("div");
    modal.style.cssText = "position:fixed;inset:0;z-index:99998;background:#000;display:flex;flex-direction:column;justify-content:space-between;";
    modal.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:16px;background:linear-gradient(to bottom,rgba(0,0,0,.8),transparent);z-index:2;">
        <span style="background:#ef4444;color:#fff;padding:4px 10px;border-radius:99px;font-size:12px;font-weight:700;">● LIVE · 360p</span>
        <span id="gvnd-live-stat" style="color:#fff;font-size:12px;font-family:monospace;">Part #1 · 0.0 MB / 100 MB</span>
        <button id="gvnd-live-stop" style="background:#fff;color:#000;border:none;padding:6px 14px;border-radius:8px;font-weight:700;">End Live</button>
      </div>
      <video id="gvnd-live-preview" autoplay muted playsinline style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;"></video>
      <div style="padding:16px;text-align:center;color:#cbd5e1;font-size:12px;background:linear-gradient(to top,rgba(0,0,0,.8),transparent);z-index:2;">
        Har 100 MB par video automatically Feed mein post hoga aur agla part bina ruke shuru ho jayega.
      </div>`;
    document.body.appendChild(modal);
    const vid = document.getElementById("gvnd-live-preview");
    vid.srcObject = stream;

    let partNum = 1;
    let activeRecorder = null;
    let isStopped = false;
    const MAX_BYTES = 100 * 1024 * 1024; // 100 MB

    const postSegment = async (chunks, part) => {
      if (!chunks.length) return;
      const blob = new Blob(chunks, { type: "video/webm" });
      const file = new File([blob], `LIVE_360p_Part_${part}_${Date.now()}.webm`, { type: "video/webm" });
      // Auto-attach & submit into Feed form
      const fileInput = document.querySelector('input[type="file"][accept*="video"]');
      const textArea = document.querySelector('textarea[placeholder*="Mesh par kya chal raha hai"]');
      if (fileInput && textArea) {
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
        textArea.value = `🔴 Live Stream (360p · Part #${part})`;
        textArea.dispatchEvent(new Event("input", { bubbles: true }));
        setTimeout(() => {
          const submitBtn = fileInput.closest("form")?.querySelector('button[type="submit"]');
          submitBtn?.click();
        }, 300);
      }
    };

    const startSegment = () => {
      if (isStopped) return;
      let chunks = [];
      let totalBytes = 0;
      const currentPart = partNum++;
      const rec = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8,opus", videoBitsPerSecond: 450000 });
      activeRecorder = rec;

      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunks.push(e.data);
          totalBytes += e.data.size;
          const mb = (totalBytes / (1024 * 1024)).toFixed(1);
          const statEl = document.getElementById("gvnd-live-stat");
          if (statEl) statEl.textContent = `Part #${currentPart} · ${mb} MB / 100 MB`;

          if (totalBytes >= MAX_BYTES && !isStopped) {
            rec.stop();
            startSegment(); // Immediately start next segment without interruption
          }
        }
      };
      rec.onstop = () => {
        postSegment(chunks, currentPart);
      };
      rec.start(1000);
    };

    startSegment();

    document.getElementById("gvnd-live-stop").onclick = () => {
      isStopped = true;
      try { activeRecorder?.stop(); } catch (e) {}
      stream.getTracks().forEach((t) => t.stop());
      modal.remove();
    };
  });

  // 4. Full-Screen Vertical Reel Player (Smooth Slide-Up + Like/Comment/Save/Share + Chunk Preload)
  window.addEventListener("gvnd-open-reel", () => {
    const videos = Array.from(document.querySelectorAll("video")).filter((v) => v.src && !v.id.includes("live"));
    if (!videos.length) return;

    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:99997;background:#000;overflow-y:scroll;scroll-snap-type:y mandatory;scroll-behavior:smooth;";

    videos.forEach((srcVid, idx) => {
      const slide = document.createElement("div");
      slide.style.cssText = "position:relative;width:100vw;height:100vh;scroll-snap-align:start;background:#000;display:flex;align-items:center;justify-content:center;";
      slide.innerHTML = `
        <button class="reel-close" style="position:absolute;top:16px;left:16px;z-index:10;background:rgba(0,0,0,.55);color:#fff;border:none;border-radius:99px;padding:8px 14px;font-size:14px;">← Back</button>
        <video src="${srcVid.src}" preload="${idx <= 1 ? "auto" : "metadata"}" loop playsinline style="width:100%;height:100%;object-fit:contain;"></video>
        <div style="position:absolute;right:14px;bottom:90px;z-index:10;display:flex;flex-direction:column;gap:18px;align-items:center;color:#fff;font-family:sans-serif;font-size:12px;">
          <button class="reel-act" data-act="Like" style="background:none;border:none;color:#fff;display:flex;flex-direction:column;align-items:center;gap:4px;font-size:22px;">🤍<span style="font-size:11px;">Like</span></button>
          <button class="reel-act" data-act="Comment" style="background:none;border:none;color:#fff;display:flex;flex-direction:column;align-items:center;gap:4px;font-size:22px;">💬<span style="font-size:11px;">Comment</span></button>
          <button class="reel-act" data-act="Save" style="background:none;border:none;color:#fff;display:flex;flex-direction:column;align-items:center;gap:4px;font-size:22px;">🔖<span style="font-size:11px;">Save</span></button>
          <button class="reel-act" data-act="Share" style="background:none;border:none;color:#fff;display:flex;flex-direction:column;align-items:center;gap:4px;font-size:22px;">↗️<span style="font-size:11px;">Share</span></button>
        </div>
        <div style="position:absolute;left:16px;bottom:28px;right:80px;z-index:10;color:#fff;font-family:sans-serif;">
          <div style="font-weight:700;font-size:14px;">@gvnd_mesh_creator</div>
          <div style="font-size:12px;color:#cbd5e1;margin-top:4px;">Swipe up for next reel · Chunk Streaming Active</div>
        </div>`;
      overlay.appendChild(slide);
    });

    document.body.appendChild(overlay);
    const slideEls = Array.from(overlay.children);

    // IntersectionObserver: Auto-play active reel & Pre-buffer next 2 reels' initial chunks
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const v = entry.target.querySelector("video");
        const index = slideEls.indexOf(entry.target);
        if (entry.isIntersecting) {
          v?.play().catch(() => {});
          // Preload next 2 videos' chunks
          [index + 1, index + 2].forEach((nextIdx) => {
            const nextVid = slideEls[nextIdx]?.querySelector("video");
            if (nextVid) nextVid.preload = "auto";
          });
        } else {
          v?.pause();
        }
      });
    }, { root: overlay, threshold: 0.75 });

    slideEls.forEach((s) => {
      obs.observe(s);
      s.querySelector(".reel-close").onclick = () => {
        obs.disconnect();
        overlay.remove();
      };
      s.querySelectorAll(".reel-act").forEach((btn) => {
        btn.onclick = () => {
          const act = btn.getAttribute("data-act");
          if (act === "Like") btn.innerHTML = '❤️<span style="font-size:11px;">Liked</span>';
          else if (act === "Save") btn.innerHTML = '✅<span style="font-size:11px;">Saved</span>';
          else if (act === "Share" && navigator.share) navigator.share({ title: "GVND Connect Reel", url: location.href }).catch(() => {});
          else if (act === "Comment") {
            const c = prompt("Comment likhein:");
            if (c) alert("Comment post ho gaya: " + c);
          }
        };
      });
    });
  });
})();
