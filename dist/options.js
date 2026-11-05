(() => {
  // src/settings.js
  var MODELS = [
    { id: "claude-opus-5-5", label: "Claude Opus 5.5 \u2014 best quality (default)" },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 \u2014 faster, cheaper" },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 \u2014 fastest, cheapest" }
  ];
  var EFFORTS = [
    { id: "low", label: "Low \u2014 fastest answers (default)" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High \u2014 most thorough, slowest" }
  ];
  var DEFAULT_SETTINGS = {
    apiKey: "",
    model: "claude-opus-5-5",
    effort: "low",
    language: "English",
    autoSummarize: false
  };
  async function loadSettings() {
    const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS).concat("apiBaseUrl"));
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  // src/options/options.js
  var $ = (id) => document.getElementById(id);
  function fillSelect(select, items) {
    for (const item of items) {
      const opt = document.createElement("option");
      opt.value = item.id;
      opt.textContent = item.label;
      select.appendChild(opt);
    }
  }
  async function init() {
    fillSelect($("model"), MODELS);
    fillSelect($("effort"), EFFORTS);
    const s = await loadSettings();
    $("apiKey").value = s.apiKey;
    $("model").value = s.model;
    $("effort").value = s.effort;
    $("language").value = s.language;
    $("autoSummarize").checked = s.autoSummarize;
    if (!s.apiKey) $("apiKey").focus();
  }
  $("toggleKey").addEventListener("click", () => {
    const input = $("apiKey");
    input.type = input.type === "password" ? "text" : "password";
    $("toggleKey").textContent = input.type === "password" ? "Show" : "Hide";
  });
  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const apiKey = $("apiKey").value.trim();
    const status = $("status");
    if (apiKey && !apiKey.startsWith("sk-ant-")) {
      status.textContent = "That doesn\u2019t look like an Anthropic API key (they start with sk-ant-).";
      status.className = "error";
      return;
    }
    await chrome.storage.local.set({
      apiKey,
      model: $("model").value || DEFAULT_SETTINGS.model,
      effort: $("effort").value || DEFAULT_SETTINGS.effort,
      language: $("language").value.trim() || DEFAULT_SETTINGS.language,
      autoSummarize: $("autoSummarize").checked
    });
    status.textContent = apiKey ? "Saved. Reload any open YouTube tabs." : "Saved (no API key yet).";
    status.className = "ok";
  });
  init();
})();
