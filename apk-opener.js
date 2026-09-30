/*!
 * apk-opener.js — drives the "Open an APK File Online" tool on
 * open-apk-file.html. Everything happens client-side: the .apk is read
 * with JSZip (it's a ZIP archive), AndroidManifest.xml is decoded with the
 * bundled AXML parser, and nothing is ever uploaded anywhere.
 */
(function () {
  "use strict";

  const DENSITY_ORDER = ["xxxhdpi", "xxhdpi", "xhdpi", "hdpi", "mdpi", "ldpi", "anydpi", "nodpi"];
  const MAX_LISTED_FILES = 800;
  const LARGE_FILE_WARN_BYTES = 250 * 1024 * 1024; // 250 MB

  const $ = (id) => document.getElementById(id);

  let els = {};
  let currentZip = null;
  let currentFileName = "app";
  let allEntries = [];

  function init() {
    els = {
      dropzone: $("apk-dropzone"),
      input: $("apk-input"),
      progress: $("apk-progress"),
      progressText: $("apk-progress-text"),
      error: $("apk-error"),
      results: $("apk-results"),
      tabs: document.querySelectorAll(".apk-tab"),
      panels: document.querySelectorAll(".apk-panel"),
      icon: $("apk-icon"),
      iconFallback: $("apk-icon-fallback"),
      appLabel: $("apk-app-label"),
      summaryTable: $("apk-summary-table"),
      permCount: $("apk-perm-count"),
      permList: $("apk-perm-list"),
      fileCount: $("apk-file-count"),
      fileFilter: $("apk-file-filter"),
      fileList: $("apk-file-list"),
      fileListNote: $("apk-file-list-note"),
      manifestPre: $("apk-manifest-pre"),
      downloadZip: $("apk-download-zip"),
      downloadManifest: $("apk-download-manifest"),
      resetBtn: $("apk-reset"),
    };

    if (!els.dropzone || !els.input) return; // tool not on this page

    els.input.addEventListener("change", (e) => {
      if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
    });

    ["dragenter", "dragover"].forEach((evt) =>
      els.dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        els.dropzone.classList.add("dragover");
      })
    );
    ["dragleave", "drop"].forEach((evt) =>
      els.dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        els.dropzone.classList.remove("dragover");
      })
    );
    els.dropzone.addEventListener("drop", (e) => {
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) handleFile(file);
    });

    els.tabs.forEach((tab) =>
      tab.addEventListener("click", () => {
        els.tabs.forEach((t) => t.classList.remove("active"));
        els.panels.forEach((p) => p.classList.remove("active"));
        tab.classList.add("active");
        $("apk-panel-" + tab.dataset.tab).classList.add("active");
      })
    );

    if (els.fileFilter) {
      els.fileFilter.addEventListener("input", () => renderFileList(els.fileFilter.value));
    }

    if (els.resetBtn) {
      els.resetBtn.addEventListener("click", resetTool);
    }
  }

  function resetTool() {
    currentZip = null;
    allEntries = [];
    els.input.value = "";
    hide(els.results);
    hide(els.error);
    hide(els.progress);
    show(els.dropzone);
  }

  function show(el) { if (el) el.hidden = false; }
  function hide(el) { if (el) el.hidden = true; }

  function showError(msg) {
    hide(els.progress);
    hide(els.results);
    show(els.dropzone);
    els.error.textContent = msg;
    show(els.error);
  }

  async function handleFile(file) {
    hide(els.error);
    hide(els.results);
    hide(els.dropzone);
    els.progressText.textContent = "Reading " + file.name + "…";
    show(els.progress);

    if (file.size > LARGE_FILE_WARN_BYTES) {
      els.progressText.textContent =
        "This is a large file (" + formatBytes(file.size) + ") — parsing in your browser, this may take a moment…";
    }

    try {
      currentFileName = file.name.replace(/\.[^/.]+$/, "") || "app";
      const buffer = await file.arrayBuffer();

      // Quick sanity check: a ZIP/APK starts with "PK".
      const head = new Uint8Array(buffer.slice(0, 2));
      if (head[0] !== 0x50 || head[1] !== 0x4b) {
        showError("This doesn't look like a valid APK file (no ZIP signature found). It may be corrupted, or not actually an .apk.");
        return;
      }

      els.progressText.textContent = "Unpacking archive…";
      const zip = await JSZip.loadAsync(buffer);
      currentZip = zip;
      allEntries = Object.keys(zip.files).map((path) => ({
        path,
        dir: zip.files[path].dir,
        size: zip.files[path]._data ? zip.files[path]._data.uncompressedSize || 0 : 0,
      }));

      els.progressText.textContent = "Reading AndroidManifest.xml…";
      let manifestSummary = null;
      let manifestError = null;
      const manifestEntry = zip.file("AndroidManifest.xml");
      if (manifestEntry) {
        try {
          const manifestBuf = await manifestEntry.async("arraybuffer");
          manifestSummary = window.AXML.summarizeManifest(manifestBuf);
        } catch (err) {
          manifestError = "Couldn't fully decode AndroidManifest.xml (" + err.message + "). Showing what's available from the file list instead.";
        }
      } else {
        manifestError = "No AndroidManifest.xml found — this may not be a standard APK.";
      }

      els.progressText.textContent = "Looking for an app icon…";
      const iconUrl = await extractIcon(zip);

      renderResults({ file, manifestSummary, manifestError, iconUrl });
    } catch (err) {
      console.error(err);
      showError("Couldn't read this file as an APK/ZIP archive. It may be corrupted or in an unsupported format (e.g. an XAPK/APKM bundle needs its inner base .apk extracted first).");
    }
  }

  async function extractIcon(zip) {
    const candidates = Object.keys(zip.files).filter(
      (p) => !zip.files[p].dir && /(^|\/)(ic_launcher|icon)[^/]*\.(png|webp)$/i.test(p)
    );
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => densityRank(a) - densityRank(b));
    try {
      const blob = await zip.files[candidates[0]].async("blob");
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }

  function densityRank(path) {
    const lower = path.toLowerCase();
    for (let i = 0; i < DENSITY_ORDER.length; i++) {
      if (lower.includes(DENSITY_ORDER[i])) return i;
    }
    return DENSITY_ORDER.length;
  }

  function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + " " + units[i];
  }

  function renderResults({ file, manifestSummary, manifestError, iconUrl }) {
    hide(els.progress);
    show(els.results);

    // --- Icon ---
    if (iconUrl) {
      els.icon.src = iconUrl;
      show(els.icon);
      hide(els.iconFallback);
    } else {
      hide(els.icon);
      show(els.iconFallback);
    }

    // --- Overview table ---
    const pkg = manifestSummary && manifestSummary.package;
    const label = manifestSummary && manifestSummary.appLabel;
    els.appLabel.textContent = pkg || file.name;

    const rows = [
      ["File name", file.name],
      ["File size", formatBytes(file.size)],
      ["Package name", pkg || "—"],
      ["Version name", (manifestSummary && manifestSummary.versionName) || "—"],
      ["Version code", (manifestSummary && manifestSummary.versionCode) ?? "—"],
      ["Min SDK version", (manifestSummary && manifestSummary.minSdkVersion) ?? "—"],
      ["Target SDK version", (manifestSummary && manifestSummary.targetSdkVersion) ?? "—"],
      ["App label resource", typeof label === "string" && label.startsWith("@0x") ? label + " (resource reference — resolved at install time)" : (label || "—")],
      ["Total files in archive", allEntries.filter((e) => !e.dir).length],
      ["Native libraries (lib/)", archSummary()],
    ];
    els.summaryTable.innerHTML = rows
      .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(String(v))}</td></tr>`)
      .join("");

    if (manifestError) {
      els.summaryTable.insertAdjacentHTML(
        "afterend",
        `<div class="callout callout-warn" style="margin-top:12px;">${escapeHtml(manifestError)}</div>`
      );
    }

    // --- Permissions ---
    const perms = (manifestSummary && manifestSummary.permissions) || [];
    els.permCount.textContent = perms.length;
    els.permList.innerHTML = perms.length
      ? perms.map((p) => `<li><code>${escapeHtml(p)}</code></li>`).join("")
      : "<li>No <code>&lt;uses-permission&gt;</code> entries were found in the manifest.</li>";

    // --- Files ---
    els.fileCount.textContent = allEntries.filter((e) => !e.dir).length;
    renderFileList("");

    // --- Manifest raw view ---
    els.manifestPre.textContent = manifestSummary
      ? JSON.stringify(
          {
            package: manifestSummary.package,
            versionCode: manifestSummary.versionCode,
            versionName: manifestSummary.versionName,
            minSdkVersion: manifestSummary.minSdkVersion,
            targetSdkVersion: manifestSummary.targetSdkVersion,
            permissions: manifestSummary.permissions,
          },
          null,
          2
        )
      : "AndroidManifest.xml could not be decoded for this file.";
  }

  function archSummary() {
    const archs = new Set();
    allEntries.forEach((e) => {
      const m = e.path.match(/^lib\/([^/]+)\//);
      if (m) archs.add(m[1]);
    });
    return archs.size ? [...archs].sort().join(", ") : "none found (pure Java/Kotlin app, or split APK)";
  }

  function renderFileList(filter) {
    const filterLower = (filter || "").toLowerCase();
    const filtered = allEntries
      .filter((e) => !e.dir)
      .filter((e) => !filterLower || e.path.toLowerCase().includes(filterLower));

    const shown = filtered.slice(0, MAX_LISTED_FILES);
    els.fileList.innerHTML = shown
      .map(
        (e) =>
          `<li><span class="apk-file-path">${escapeHtml(e.path)}</span><span class="apk-file-size">${formatBytes(e.size)}</span></li>`
      )
      .join("");

    if (filtered.length > MAX_LISTED_FILES) {
      els.fileListNote.textContent = `Showing first ${MAX_LISTED_FILES} of ${filtered.length} matching files. Narrow your search or download the full extracted archive below.`;
      show(els.fileListNote);
    } else if (filtered.length === 0) {
      els.fileListNote.textContent = "No files match that filter.";
      show(els.fileListNote);
    } else {
      hide(els.fileListNote);
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  async function downloadExtractedZip() {
    if (!currentZip) return;
    els.downloadZip.disabled = true;
    els.downloadZip.textContent = "Preparing download…";
    try {
      const blob = await currentZip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });
      triggerDownload(blob, currentFileName + "-extracted.zip");
    } finally {
      els.downloadZip.disabled = false;
      els.downloadZip.textContent = "Download extracted files (.zip)";
    }
  }

  function downloadManifestText() {
    const text = els.manifestPre.textContent;
    const blob = new Blob([text], { type: "text/plain" });
    triggerDownload(blob, currentFileName + "-manifest.json");
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  document.addEventListener("DOMContentLoaded", () => {
    init();
    const dz = $("apk-download-zip");
    const dm = $("apk-download-manifest");
    if (dz) dz.addEventListener("click", downloadExtractedZip);
    if (dm) dm.addEventListener("click", downloadManifestText);
  });
})();
