(function runPopup() {
  "use strict";

  const storage = window.AutofillStorage;

  const state = {
    tab: null,
    siteKey: "",
    settings: storage.normalizeSettings(),
    siteData: storage.normalizeSiteData(),
    scanResults: []
  };

  const elements = {};

  function cacheElements() {
    elements.statusBadge = document.getElementById("statusBadge");
    elements.siteKey = document.getElementById("siteKey");
    elements.fillNowButton = document.getElementById("fillNowButton");
    elements.scanInputsButton = document.getElementById("scanInputsButton");
    elements.saveChangesButton = document.getElementById("saveChangesButton");
    elements.message = document.getElementById("message");
    elements.autoFieldsList = document.getElementById("autoFieldsList");
    elements.manualRulesList = document.getElementById("manualRulesList");
    elements.scanResultsList = document.getElementById("scanResultsList");
    elements.autoCount = document.getElementById("autoCount");
    elements.manualCount = document.getElementById("manualCount");
    elements.scanCount = document.getElementById("scanCount");
    elements.manualRuleForm = document.getElementById("manualRuleForm");
    elements.manualLabel = document.getElementById("manualLabel");
    elements.manualSelector = document.getElementById("manualSelector");
    elements.manualValue = document.getElementById("manualValue");
    elements.manualEnabled = document.getElementById("manualEnabled");
    elements.allowUnsafeFields = document.getElementById("allowUnsafeFields");
    elements.safetyModeText = document.getElementById("safetyModeText");
    elements.unsafeModeWarning = document.getElementById("unsafeModeWarning");
  }

  function setStatus(text) {
    elements.statusBadge.textContent = text;
  }

  function showMessage(text, type = "") {
    elements.message.textContent = text;
    elements.message.className = `message visible ${type}`.trim();
  }

  function clearMessage() {
    elements.message.textContent = "";
    elements.message.className = "message";
  }

  function setButtonsDisabled(isDisabled) {
    elements.fillNowButton.disabled = isDisabled;
    elements.scanInputsButton.disabled = isDisabled;
    elements.saveChangesButton.disabled = isDisabled;
  }

  function getActiveTab() {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const error = chrome.runtime.lastError;

        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve(tabs[0] || null);
      });
    });
  }

  function getSiteKeyFromTabUrl(tab) {
    if (!tab || !tab.url) {
      return "";
    }

    try {
      const url = new URL(tab.url);

      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return "";
      }

      return url.origin + url.pathname;
    } catch (error) {
      return "";
    }
  }

  function sendMessageOnce(message) {
    return new Promise((resolve, reject) => {
      if (!state.tab || typeof state.tab.id !== "number") {
        reject(new Error("No active tab is available."));
        return;
      }

      chrome.tabs.sendMessage(state.tab.id, message, (response) => {
        const error = chrome.runtime.lastError;

        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve(response);
      });
    });
  }

  function isMissingContentScriptError(error) {
    return /receiving end does not exist|could not establish connection/i.test(error.message || "");
  }

  function injectContentScript() {
    return new Promise((resolve, reject) => {
      if (!state.tab || typeof state.tab.id !== "number") {
        reject(new Error("No active tab is available."));
        return;
      }

      chrome.scripting.executeScript(
        {
          target: { tabId: state.tab.id },
          files: ["src/storage.js", "src/content.js"]
        },
        () => {
          const error = chrome.runtime.lastError;

          if (error) {
            reject(new Error(error.message));
            return;
          }

          resolve();
        }
      );
    });
  }

  async function sendMessageToTab(message) {
    try {
      return await sendMessageOnce(message);
    } catch (error) {
      if (!isMissingContentScriptError(error)) {
        throw error;
      }

      await injectContentScript();
      return sendMessageOnce(message);
    }
  }

  async function loadSiteKey() {
    try {
      const response = await sendMessageToTab({ type: "GET_SITE_KEY" });

      if (response && response.ok && response.siteKey) {
        return response.siteKey;
      }
    } catch (error) {
      // Some pages do not allow content scripts. The tab URL fallback keeps editing possible.
    }

    return getSiteKeyFromTabUrl(state.tab);
  }

  function createEmptyState(text) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = text;
    return empty;
  }

  function createTextInput(value, role) {
    const input = document.createElement("textarea");
    input.value = value || "";
    input.dataset.role = role;
    input.rows = 2;
    return input;
  }

  function createEnabledCheckbox(isEnabled, role) {
    const label = document.createElement("label");
    label.className = "inline-control";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = isEnabled !== false;
    checkbox.dataset.role = role;

    label.append(checkbox, "Enabled");
    return label;
  }

  function renderSafetySettings() {
    const allowUnsafeFields = state.settings.allowUnsafeFields === true;

    elements.allowUnsafeFields.checked = allowUnsafeFields;
    elements.safetyModeText.textContent = allowUnsafeFields ? "Permisivo" : "Seguro";
    elements.unsafeModeWarning.hidden = !allowUnsafeFields;
  }

  function getFieldHistory(field) {
    const history = Array.isArray(field.history) ? field.history : [];

    return history
      .map((entry) => {
        if (entry && typeof entry === "object") {
          return {
            value: String(entry.value ?? ""),
            useCount: Number.isFinite(Number(entry.useCount)) ? Number(entry.useCount) : 0,
            createdAt: entry.createdAt || "",
            lastUsedAt: entry.lastUsedAt || ""
          };
        }

        return {
          value: String(entry ?? ""),
          useCount: 0,
          createdAt: "",
          lastUsedAt: ""
        };
      })
      .filter((entry) => entry.value !== "");
  }

  function createSavedValuesList(selector, field) {
    const wrapper = document.createElement("div");
    wrapper.className = "saved-values";

    const title = document.createElement("p");
    title.className = "saved-values-title";
    title.textContent = "Valores guardados";
    wrapper.append(title);

    const history = getFieldHistory(field);

    if (history.length === 0) {
      const empty = document.createElement("p");
      empty.className = "saved-values-empty";
      empty.textContent = "Sin valores guardados.";
      wrapper.append(empty);
      return wrapper;
    }

    const list = document.createElement("div");
    list.className = "saved-values-list";

    history.forEach((entry, index) => {
      const item = document.createElement("div");
      item.className = "saved-value-item";

      const value = document.createElement("span");
      value.className = "saved-value-text";
      value.title = entry.value;
      value.textContent = entry.value;

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "danger small icon-button";
      deleteButton.dataset.action = "delete-auto-value";
      deleteButton.dataset.selector = selector;
      deleteButton.dataset.historyIndex = String(index);
      deleteButton.title = "Eliminar valor guardado";
      deleteButton.textContent = "x";

      item.append(value, deleteButton);
      list.append(item);
    });

    wrapper.append(list);
    return wrapper;
  }

  function renderAutoFields() {
    const fields = state.siteData.autoCapturedFields || {};
    const entries = Object.entries(fields);
    elements.autoFieldsList.replaceChildren();
    elements.autoCount.textContent = String(entries.length);

    if (entries.length === 0) {
      elements.autoFieldsList.append(createEmptyState("Aun no hay campos autoguardados."));
      return;
    }

    entries.forEach(([selector, field]) => {
      const card = document.createElement("article");
      card.className = "field-card";
      card.dataset.autoSelector = selector;

      const header = document.createElement("div");
      header.className = "field-card-header";

      const title = document.createElement("div");
      title.className = "field-title";

      const titleText = document.createElement("strong");
      titleText.textContent = "Auto field";

      const selectorCode = document.createElement("code");
      selectorCode.className = "selector-code";
      selectorCode.textContent = selector;
      title.append(titleText, selectorCode);

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "danger small";
      deleteButton.dataset.action = "delete-auto";
      deleteButton.dataset.selector = selector;
      deleteButton.textContent = "Eliminar";

      header.append(title, deleteButton);

      const grid = document.createElement("div");
      grid.className = "field-grid";

      const valueLabel = document.createElement("label");
      valueLabel.textContent = "Value";
      valueLabel.append(createTextInput(field.value, "auto-value"));

      grid.append(
        valueLabel,
        createEnabledCheckbox(field.enabled, "auto-enabled")
      );

      card.append(header, grid, createSavedValuesList(selector, field));
      elements.autoFieldsList.append(card);
    });
  }

  function renderManualRules() {
    const rules = Array.isArray(state.siteData.manualRules) ? state.siteData.manualRules : [];
    elements.manualRulesList.replaceChildren();
    elements.manualCount.textContent = String(rules.length);

    if (rules.length === 0) {
      elements.manualRulesList.append(createEmptyState("Aun no hay reglas manuales."));
      return;
    }

    rules.forEach((rule) => {
      const card = document.createElement("article");
      card.className = "field-card";
      card.dataset.ruleId = rule.id;

      const header = document.createElement("div");
      header.className = "field-card-header";

      const title = document.createElement("div");
      title.className = "field-title";

      const titleText = document.createElement("strong");
      titleText.textContent = rule.label || "Manual rule";

      const selectorCode = document.createElement("code");
      selectorCode.className = "selector-code";
      selectorCode.textContent = rule.selector;
      title.append(titleText, selectorCode);

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "danger small";
      deleteButton.dataset.action = "delete-rule";
      deleteButton.dataset.ruleId = rule.id;
      deleteButton.textContent = "Eliminar";

      header.append(title, deleteButton);

      const grid = document.createElement("div");
      grid.className = "field-grid";

      const labelField = document.createElement("label");
      labelField.textContent = "Label";
      const labelInput = document.createElement("input");
      labelInput.type = "text";
      labelInput.value = rule.label || "";
      labelInput.dataset.role = "rule-label";
      labelField.append(labelInput);

      const selectorField = document.createElement("label");
      selectorField.textContent = "CSS selector";
      const selectorInput = document.createElement("input");
      selectorInput.type = "text";
      selectorInput.value = rule.selector || "";
      selectorInput.dataset.role = "rule-selector";
      selectorField.append(selectorInput);

      const valueField = document.createElement("label");
      valueField.textContent = "Value";
      valueField.append(createTextInput(rule.value, "rule-value"));

      grid.append(
        labelField,
        selectorField,
        valueField,
        createEnabledCheckbox(rule.enabled, "rule-enabled")
      );

      card.append(header, grid);
      elements.manualRulesList.append(card);
    });
  }

  function renderScanResults() {
    elements.scanResultsList.replaceChildren();
    elements.scanCount.textContent = String(state.scanResults.length);

    if (state.scanResults.length === 0) {
      elements.scanResultsList.append(createEmptyState("Escanea la pagina para ver inputs disponibles."));
      return;
    }

    state.scanResults.forEach((input, index) => {
      const card = document.createElement("article");
      card.className = "field-card";

      const header = document.createElement("div");
      header.className = "field-card-header";

      const title = document.createElement("div");
      title.className = "field-title";

      const titleText = document.createElement("strong");
      titleText.textContent = input.label || "Detected input";

      const selectorCode = document.createElement("code");
      selectorCode.className = "selector-code";
      selectorCode.textContent = input.selector;
      title.append(titleText, selectorCode);

      const useButton = document.createElement("button");
      useButton.type = "button";
      useButton.className = "secondary small";
      useButton.dataset.action = "use-scan";
      useButton.dataset.index = String(index);
      useButton.textContent = "Usar";

      const meta = document.createElement("p");
      meta.className = "scan-meta";
      meta.textContent = `${input.tagName} | ${input.type} | Value: ${input.value || "(empty)"}`;

      header.append(title, useButton);
      card.append(header, meta);
      elements.scanResultsList.append(card);
    });
  }

  function render() {
    elements.siteKey.textContent = state.siteKey || "Pagina no compatible.";
    renderSafetySettings();
    renderAutoFields();
    renderManualRules();
    renderScanResults();
  }

  async function notifyContentSettingsChanged() {
    if (!state.siteKey) {
      return;
    }

    try {
      await sendMessageToTab({
        type: "SETTINGS_CHANGED",
        settings: state.settings
      });
    } catch (error) {
      // Some pages cannot receive extension messages. The next content load will read storage.
    }
  }

  async function handleSafetyModeChange(event) {
    const allowUnsafeFields = event.target.checked;

    if (allowUnsafeFields) {
      const confirmed = window.confirm(
        "Advertencia: el modo permisivo puede guardar contrasenas, tokens, codigos, PIN, datos bancarios o tarjetas en chrome.storage.local. Continuar?"
      );

      if (!confirmed) {
        renderSafetySettings();
        return;
      }
    }

    try {
      state.settings = await storage.saveSettings({ allowUnsafeFields });
      renderSafetySettings();
      await notifyContentSettingsChanged();
      showMessage(
        allowUnsafeFields
          ? "Modo permisivo activado. Revisa bien que datos guardas."
          : "Modo seguro activado.",
        allowUnsafeFields ? "error" : "success"
      );
    } catch (error) {
      renderSafetySettings();
      showMessage(error.message, "error");
    }
  }

  function collectAutoFields() {
    const autoCapturedFields = {};
    const rows = Array.from(elements.autoFieldsList.querySelectorAll("[data-auto-selector]"));
    const now = new Date().toISOString();

    rows.forEach((row) => {
      const selector = row.dataset.autoSelector;
      const value = row.querySelector("[data-role='auto-value']").value;
      const enabled = row.querySelector("[data-role='auto-enabled']").checked;
      const existing = state.siteData.autoCapturedFields[selector] || {};

      autoCapturedFields[selector] = {
        selector,
        value,
        enabled,
        lastUpdated: now,
        source: existing.source || "auto",
        history: Array.isArray(existing.history) ? existing.history : []
      };
    });

    return autoCapturedFields;
  }

  function collectManualRules() {
    const rows = Array.from(elements.manualRulesList.querySelectorAll("[data-rule-id]"));
    const now = new Date().toISOString();

    return rows.map((row) => {
      const id = row.dataset.ruleId;
      const existing = state.siteData.manualRules.find((rule) => rule.id === id) || {};

      return {
        id,
        label: row.querySelector("[data-role='rule-label']").value.trim(),
        selector: row.querySelector("[data-role='rule-selector']").value.trim(),
        value: row.querySelector("[data-role='rule-value']").value,
        enabled: row.querySelector("[data-role='rule-enabled']").checked,
        createdAt: existing.createdAt || now,
        updatedAt: now,
        useCount: Number.isFinite(Number(existing.useCount)) ? Number(existing.useCount) : 0,
        lastUsedAt: existing.lastUsedAt || ""
      };
    });
  }

  async function saveCurrentSiteData() {
    if (!state.siteKey) {
      throw new Error("This page does not have a valid site key.");
    }

    state.siteData = await storage.saveSiteData(state.siteKey, state.siteData);
    render();
  }

  async function validateManualRules(rules) {
    for (const rule of rules) {
      if (!rule.label || rule.label.length < 2) {
        throw new Error("Each manual rule label must have at least 2 characters.");
      }

      if (!rule.selector) {
        throw new Error("Each manual rule needs a CSS selector.");
      }

      if (rule.enabled !== false) {
        await validateSelectorOnPage(rule.selector);
      }
    }
  }

  async function persistEditorChanges() {
    const nextSiteData = {
      autoCapturedFields: collectAutoFields(),
      manualRules: collectManualRules()
    };

    await validateManualRules(nextSiteData.manualRules);
    state.siteData = nextSiteData;
    await saveCurrentSiteData();
  }

  async function handleSaveChanges() {
    try {
      setButtonsDisabled(true);
      setStatus("Guardando");
      await persistEditorChanges();
      showMessage("Cambios guardados.", "success");
    } catch (error) {
      showMessage(error.message, "error");
    } finally {
      setButtonsDisabled(false);
      setStatus("Listo");
    }
  }

  async function handleFillNow() {
    try {
      setButtonsDisabled(true);
      setStatus("Rellenando");
      await persistEditorChanges();

      const response = await sendMessageToTab({ type: "FILL_NOW" });

      if (!response || !response.ok) {
        throw new Error(response && response.error ? response.error : "Could not fill this page.");
      }

      const count = response.result ? response.result.totalFilledCount : 0;
      showMessage(`Relleno ejecutado. Campos actualizados: ${count}.`, "success");
    } catch (error) {
      showMessage(error.message, "error");
    } finally {
      setButtonsDisabled(false);
      setStatus("Listo");
    }
  }

  async function handleScanInputs() {
    try {
      setButtonsDisabled(true);
      setStatus("Escaneando");
      const response = await sendMessageToTab({ type: "SCAN_INPUTS" });

      if (!response || !response.ok) {
        throw new Error("Could not scan inputs on this page.");
      }

      state.scanResults = response.inputs || [];
      renderScanResults();
      showMessage(`Inputs detectados: ${state.scanResults.length}.`, "success");
    } catch (error) {
      showMessage(error.message, "error");
    } finally {
      setButtonsDisabled(false);
      setStatus("Listo");
    }
  }

  async function validateSelectorOnPage(selector) {
    const response = await sendMessageToTab({ type: "TEST_SELECTOR", selector });

    if (!response || !response.ok || !response.result) {
      throw new Error("Could not validate the selector.");
    }

    if (!response.result.isValid) {
      throw new Error(response.result.error || "The CSS selector is not valid.");
    }

    if (response.result.safeMatchCount < 1) {
      throw new Error("The selector must match at least one safe input on this page.");
    }
  }

  async function handleManualRuleSubmit(event) {
    event.preventDefault();
    clearMessage();

    const label = elements.manualLabel.value.trim();
    const selector = elements.manualSelector.value.trim();
    const value = elements.manualValue.value;
    const enabled = elements.manualEnabled.checked;

    try {
      if (label.length < 2) {
        throw new Error("Label must have at least 2 characters.");
      }

      if (!selector) {
        throw new Error("CSS selector is required.");
      }

      if (value === "" && !window.confirm("La regla guardara un value vacio. Continuar?")) {
        return;
      }

      setButtonsDisabled(true);
      setStatus("Validando");
      await validateSelectorOnPage(selector);

      await storage.upsertManualRule(state.siteKey, {
        label,
        selector,
        value,
        enabled
      });

      state.siteData = await storage.getSiteData(state.siteKey);
      elements.manualRuleForm.reset();
      elements.manualEnabled.checked = true;
      render();
      showMessage("Regla manual guardada.", "success");
    } catch (error) {
      showMessage(error.message, "error");
    } finally {
      setButtonsDisabled(false);
      setStatus("Listo");
    }
  }

  async function handleListClick(event) {
    const button = event.target.closest("button[data-action]");

    if (!button) {
      return;
    }

    const action = button.dataset.action;

    if (action === "delete-auto") {
      const selector = button.dataset.selector;
      delete state.siteData.autoCapturedFields[selector];
      await saveCurrentSiteData();
      showMessage("Campo autoguardado eliminado.", "success");
    }

    if (action === "delete-auto-value") {
      const selector = button.dataset.selector;
      const historyIndex = Number(button.dataset.historyIndex);
      const row = button.closest("[data-auto-selector]");
      const field = state.siteData.autoCapturedFields[selector];
      const history = field ? getFieldHistory(field) : [];
      const valueEntry = history[historyIndex];

      if (!field || !valueEntry) {
        return;
      }

      if (row) {
        field.value = row.querySelector("[data-role='auto-value']").value;
        field.enabled = row.querySelector("[data-role='auto-enabled']").checked;
      }

      field.history = history.filter((entry, index) => index !== historyIndex);

      if (field.value === valueEntry.value) {
        field.value = field.history[0] ? field.history[0].value : "";
      }

      if (field.history.length === 0 && !field.value) {
        delete state.siteData.autoCapturedFields[selector];
      }

      await saveCurrentSiteData();
      showMessage("Valor guardado eliminado.", "success");
    }

    if (action === "delete-rule") {
      const ruleId = button.dataset.ruleId;
      state.siteData.manualRules = state.siteData.manualRules.filter((rule) => rule.id !== ruleId);
      await saveCurrentSiteData();
      showMessage("Regla manual eliminada.", "success");
    }

    if (action === "use-scan") {
      const input = state.scanResults[Number(button.dataset.index)];

      if (!input) {
        return;
      }

      elements.manualLabel.value = input.label || "Detected input";
      elements.manualSelector.value = input.selector || "";
      elements.manualValue.value = input.value || "";
      elements.manualEnabled.checked = true;
      elements.manualLabel.focus();
      showMessage("Input cargado en el formulario de regla manual.", "success");
    }
  }

  function bindEvents() {
    elements.fillNowButton.addEventListener("click", handleFillNow);
    elements.scanInputsButton.addEventListener("click", handleScanInputs);
    elements.saveChangesButton.addEventListener("click", handleSaveChanges);
    elements.allowUnsafeFields.addEventListener("change", handleSafetyModeChange);
    elements.manualRuleForm.addEventListener("submit", handleManualRuleSubmit);
    elements.autoFieldsList.addEventListener("click", handleListClick);
    elements.manualRulesList.addEventListener("click", handleListClick);
    elements.scanResultsList.addEventListener("click", handleListClick);
  }

  async function initialize() {
    cacheElements();
    bindEvents();
    setButtonsDisabled(true);
    setStatus("Cargando");

    try {
      state.settings = await storage.getSettings();
      state.tab = await getActiveTab();
      state.siteKey = await loadSiteKey();

      if (!state.siteKey) {
        throw new Error("Abre una pagina http o https para usar la extension.");
      }

      state.siteData = await storage.getSiteData(state.siteKey);
      render();
      clearMessage();
    } catch (error) {
      render();
      showMessage(error.message, "error");
    } finally {
      setButtonsDisabled(!state.siteKey);
      setStatus("Listo");
    }
  }

  document.addEventListener("DOMContentLoaded", initialize);
})();
