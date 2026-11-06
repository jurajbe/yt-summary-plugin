(() => {
  // src/settings.js
  var PROVIDERS = [
    { id: "ollama", label: "Ollama (cloud or local)" },
    { id: "anthropic", label: "Claude (Anthropic API key)" }
  ];
  var CLAUDE_MODELS = [
    { id: "claude-opus-5-5", label: "Claude Opus 5.5 \u2014 best quality (default)" },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 \u2014 faster, cheaper" },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 \u2014 fastest, cheapest" }
  ];
  var EFFORTS = [
    { id: "low", label: "Low \u2014 fastest answers (default)" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High \u2014 most thorough, slowest" }
  ];
  var CONTEXT_SIZES = [
    { id: 8192, label: "8k \u2014 short videos only (least memory)" },
    { id: 16384, label: "16k \u2014 up to ~25 min videos" },
    { id: 32768, label: "32k \u2014 up to ~1 hour (default)" },
    { id: 65536, label: "64k \u2014 up to ~2 hours" },
    { id: 131072, label: "128k \u2014 long podcasts (lots of memory)" }
  ];
  var SUGGESTED_OLLAMA_MODELS = [
    { name: "gemma3:4b", size: "3.3 GB", ram: "8 GB RAM", note: "Fast; fine for short videos, misses detail on long ones." },
    { name: "llama3.1:8b", size: "4.9 GB", ram: "8\u201316 GB RAM", note: "Reliable all-rounder, 128k context." },
    { name: "qwen3:8b", size: "5.2 GB", ram: "16 GB RAM", note: "Strong for its size. Reasoning model: effort Low turns thinking off for speed." },
    { name: "gemma3:12b", size: "8.1 GB", ram: "16 GB RAM", note: "Best quality-per-GB for summaries. Recommended start." },
    { name: "qwen3:14b", size: "9.3 GB", ram: "16\u201324 GB RAM", note: "Very good summaries and follow-up answers." },
    { name: "gpt-oss:20b", size: "14 GB", ram: "24 GB RAM / 16 GB VRAM", note: "OpenAI open-weight reasoning model; great on tricky follow-ups." },
    { name: "qwen3:30b", size: "19 GB", ram: "32 GB RAM", note: "Mixture-of-experts: big-model quality at small-model speed." },
    { name: "gemma3:27b", size: "17 GB", ram: "32 GB RAM / 24 GB VRAM", note: "Best local quality in this list." }
  ];
  var DEFAULT_SETTINGS = {
    provider: "ollama",
    // Claude
    apiKey: "",
    model: "claude-opus-5-5",
    effort: "low",
    // Ollama
    ollamaMode: "cloud",
    // 'cloud' (ollama.com, API key) or 'local' (your own Ollama server)
    ollamaApiKey: "",
    ollamaCloudModel: "",
    // empty = best available cloud model
    ollamaUrl: "http://localhost:11434",
    ollamaModel: "",
    ollamaMaxContext: 32768,
    // Both
    language: "English",
    autoSummarize: false
  };
  async function loadSettings() {
    const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS).concat("apiBaseUrl", "ollamaCloudBaseUrl"));
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  // src/providers/ollama.js
  var PREFERRED_CLOUD_MODELS = [/^gpt-oss:120b/, /^deepseek-v3/, /^qwen3(?!-coder)/, /^kimi-k2/, /^glm-4/, /^gpt-oss/];
  function pickCloudModel(names) {
    for (const re of PREFERRED_CLOUD_MODELS) {
      const hit = names.find((n) => re.test(n));
      if (hit) return hit;
    }
    return names[0] || "gpt-oss:120b";
  }

  // src/options/options.js
  var $ = (id) => document.getElementById(id);
  var savedOllamaModel = "";
  var savedCloudModel = "";
  var localConnected = false;
  function fillSelect(select, items) {
    for (const item of items) {
      const opt = document.createElement("option");
      opt.value = item.id;
      opt.textContent = item.label;
      select.appendChild(opt);
    }
  }
  function currentProvider() {
    return document.querySelector('input[name="provider"]:checked')?.value || DEFAULT_SETTINGS.provider;
  }
  function currentOllamaMode() {
    return document.querySelector('input[name="ollamaMode"]:checked')?.value || DEFAULT_SETTINGS.ollamaMode;
  }
  function showProvider() {
    const p = currentProvider();
    const mode = currentOllamaMode();
    $("ollamaSection").hidden = p !== "ollama";
    $("anthropicSection").hidden = p !== "anthropic";
    $("cloudSection").hidden = mode !== "cloud";
    $("localSection").hidden = mode !== "local";
    $("autoHint").textContent = p === "ollama" && mode === "local" ? "(runs your local model on every video you open)" : "(uses API credits/quota on every video you open)";
    if (p === "ollama" && mode === "local" && !localConnected && isLocal($("ollamaUrl").value)) connect();
  }
  function timeAgo(ts) {
    if (!ts) return "never";
    const mins = Math.round((Date.now() - ts) / 6e4);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
  }
  async function loadCloudModels(force = false) {
    const status = $("cloudStatus");
    const select = $("ollamaCloudModel");
    status.textContent = force ? "Refreshing\u2026" : "Loading\u2026";
    status.className = "hint";
    const res = await chrome.runtime.sendMessage({ type: "cloudModels", force, apiKey: $("ollamaApiKey").value.trim() });
    const models = res?.models || [];
    const previous = select.value || savedCloudModel;
    select.replaceChildren();
    const names = models.map((m) => m.name);
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = names.length ? `Auto \u2014 best available (now: ${pickCloudModel(names)})` : "Auto \u2014 best available";
    select.appendChild(auto);
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.name;
      opt.textContent = m.parameterSize ? `${m.name} (${m.parameterSize})` : m.name;
      select.appendChild(opt);
    }
    if (previous && !names.includes(previous)) {
      const opt = document.createElement("option");
      opt.value = previous;
      opt.textContent = `${previous} (no longer listed)`;
      select.appendChild(opt);
    }
    select.value = previous || "";
    if (res?.ok) {
      status.textContent = `${models.length} cloud models \xB7 updated ${timeAgo(res.fetchedAt)} \xB7 refreshes daily`;
      status.className = "hint ok";
    } else {
      status.textContent = `${res?.error || "Could not load the cloud model list."}${models.length ? ` Showing the list from ${timeAgo(res.fetchedAt)}.` : ""}`;
      status.className = "hint error";
    }
  }
  function buildProviders(selected) {
    for (const p of PROVIDERS) {
      const label = document.createElement("label");
      label.className = "provider";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "provider";
      input.value = p.id;
      input.checked = p.id === selected;
      input.addEventListener("change", showProvider);
      const span = document.createElement("span");
      span.textContent = p.label;
      label.append(input, span);
      $("providers").appendChild(label);
    }
  }
  function buildSuggestions() {
    const body = $("suggestedModels");
    for (const m of SUGGESTED_OLLAMA_MODELS) {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      const code = document.createElement("code");
      code.textContent = m.name;
      const note = document.createElement("div");
      note.className = "hint";
      note.textContent = m.note;
      name.append(code, note);
      const size = document.createElement("td");
      size.textContent = m.size;
      const ram = document.createElement("td");
      ram.textContent = m.ram;
      const copyCell = document.createElement("td");
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "secondary small";
      copy.textContent = "Copy pull command";
      copy.addEventListener("click", async () => {
        await navigator.clipboard.writeText(`ollama pull ${m.name}`);
        copy.textContent = "Copied \u2713";
        setTimeout(() => copy.textContent = "Copy pull command", 1500);
      });
      copyCell.appendChild(copy);
      tr.append(name, size, ram, copyCell);
      body.appendChild(tr);
    }
  }
  function isLocal(url) {
    try {
      const host = new URL(/^https?:\/\//.test(url) ? url : `http://${url}`).hostname;
      return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    } catch {
      return false;
    }
  }
  function requestHostPermission(url) {
    if (!url || isLocal(url)) return Promise.resolve(true);
    const origin = new URL(/^https?:\/\//.test(url) ? url : `http://${url}`).origin;
    return chrome.permissions.request({ origins: [`${origin}/*`] });
  }
  async function connect() {
    localConnected = true;
    const url = $("ollamaUrl").value.trim() || DEFAULT_SETTINGS.ollamaUrl;
    const status = $("ollamaStatus");
    const granted = await requestHostPermission(url).catch(() => false);
    if (!granted) {
      status.textContent = "Permission to reach that server was not granted.";
      status.className = "hint error";
      return;
    }
    status.textContent = "Connecting\u2026";
    status.className = "hint";
    const res = await chrome.runtime.sendMessage({ type: "ollamaModels", url });
    const select = $("ollamaModel");
    const previous = select.value || savedOllamaModel;
    select.replaceChildren();
    if (!res?.ok) {
      status.textContent = res?.error || "Could not connect to Ollama.";
      status.className = "hint error";
      const opt = document.createElement("option");
      opt.value = previous;
      opt.textContent = previous || "\u2014 not connected \u2014";
      select.appendChild(opt);
      return;
    }
    if (!res.models.length) {
      status.textContent = "Connected, but no models are installed yet. Pull one from the suggestions below, then click Connect again.";
      status.className = "hint error";
      $("suggestions").open = true;
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "\u2014 no models installed \u2014";
      select.appendChild(opt);
      return;
    }
    for (const m of res.models) {
      const opt = document.createElement("option");
      opt.value = m.name;
      const gb = m.size ? ` \xB7 ${(m.size / 1e9).toFixed(1)} GB` : "";
      opt.textContent = `${m.name}${m.parameterSize ? ` (${m.parameterSize})` : ""}${gb}`;
      select.appendChild(opt);
    }
    const names = res.models.map((m) => m.name);
    const suggested = SUGGESTED_OLLAMA_MODELS.map((m) => m.name).reverse().find((n) => names.includes(n));
    select.value = names.includes(previous) ? previous : suggested || names[0];
    status.textContent = `Connected to Ollama \u2014 ${res.models.length} model${res.models.length === 1 ? "" : "s"} installed.`;
    status.className = "hint ok";
  }
  async function init() {
    const s = await loadSettings();
    buildProviders(s.provider);
    for (const input of document.querySelectorAll('input[name="ollamaMode"]')) {
      input.checked = input.value === s.ollamaMode;
      input.addEventListener("change", showProvider);
    }
    $("ollamaApiKey").value = s.ollamaApiKey;
    savedCloudModel = s.ollamaCloudModel;
    buildSuggestions();
    fillSelect($("model"), CLAUDE_MODELS);
    fillSelect($("effort"), EFFORTS);
    fillSelect($("ollamaMaxContext"), CONTEXT_SIZES);
    $("apiKey").value = s.apiKey;
    $("model").value = s.model;
    $("effort").value = s.effort;
    $("language").value = s.language;
    $("autoSummarize").checked = s.autoSummarize;
    $("ollamaUrl").value = s.ollamaUrl;
    $("ollamaMaxContext").value = String(s.ollamaMaxContext);
    savedOllamaModel = s.ollamaModel;
    if (s.ollamaModel) {
      const opt = $("ollamaModel").options[0];
      opt.value = s.ollamaModel;
      opt.textContent = s.ollamaModel;
    }
    showProvider();
    loadCloudModels();
  }
  $("connect").addEventListener("click", connect);
  $("refreshCloud").addEventListener("click", () => loadCloudModels(true));
  $("toggleOllamaKey").addEventListener("click", () => {
    const input = $("ollamaApiKey");
    input.type = input.type === "password" ? "text" : "password";
    $("toggleOllamaKey").textContent = input.type === "password" ? "Show" : "Hide";
  });
  $("toggleKey").addEventListener("click", () => {
    const input = $("apiKey");
    input.type = input.type === "password" ? "text" : "password";
    $("toggleKey").textContent = input.type === "password" ? "Show" : "Hide";
  });
  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = $("status");
    const provider = currentProvider();
    const apiKey = $("apiKey").value.trim();
    const ollamaMode = currentOllamaMode();
    const ollamaApiKey = $("ollamaApiKey").value.trim();
    const ollamaUrl = $("ollamaUrl").value.trim() || DEFAULT_SETTINGS.ollamaUrl;
    const ollamaModel = $("ollamaModel").value;
    if (provider === "anthropic" && apiKey && !apiKey.startsWith("sk-ant-")) {
      status.textContent = "That doesn\u2019t look like an Anthropic API key (they start with sk-ant-).";
      status.className = "error";
      return;
    }
    if (provider === "ollama" && ollamaMode === "local" && !await requestHostPermission(ollamaUrl).catch(() => false)) {
      status.textContent = "Permission to reach that Ollama server was not granted.";
      status.className = "error";
      return;
    }
    await chrome.storage.local.set({
      provider,
      apiKey,
      model: $("model").value || DEFAULT_SETTINGS.model,
      effort: $("effort").value || DEFAULT_SETTINGS.effort,
      ollamaMode,
      ollamaApiKey,
      ollamaCloudModel: $("ollamaCloudModel").value,
      ollamaUrl,
      ollamaModel,
      ollamaMaxContext: Number($("ollamaMaxContext").value) || DEFAULT_SETTINGS.ollamaMaxContext,
      language: $("language").value.trim() || DEFAULT_SETTINGS.language,
      autoSummarize: $("autoSummarize").checked
    });
    savedOllamaModel = ollamaModel;
    savedCloudModel = $("ollamaCloudModel").value;
    let missing = "";
    if (provider === "anthropic" && !apiKey) missing = " Add an Anthropic API key to finish setup.";
    if (provider === "ollama" && ollamaMode === "cloud" && !ollamaApiKey) missing = " Add your Ollama API key to finish setup.";
    if (provider === "ollama" && ollamaMode === "local" && !ollamaModel) missing = " Pick a model to finish setup.";
    if (provider === "ollama" && ollamaMode === "cloud" && ollamaApiKey) loadCloudModels(true);
    status.textContent = `Saved.${missing || " You\u2019re all set \u2014 open a YouTube video."}`;
    status.className = missing ? "error" : "ok";
  });
  init();
})();
