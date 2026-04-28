(function runContentScript() {
  "use strict";

  const storage = window.AutofillStorage;

  if (window.__workInputAutofillLoaded) {
    return;
  }

  if (!storage) {
    console.error("AutofillStorage is not available.");
    return;
  }

  window.__workInputAutofillLoaded = true;

  const ALLOWED_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
  const BLOCKED_INPUT_TYPES = new Set([
    "password",
    "hidden",
    "file",
    "submit",
    "button",
    "reset",
    "checkbox",
    "radio"
  ]);
  const BLOCKED_KEYWORDS = [
    "password",
    "pass",
    "token",
    "secret",
    "credit",
    "card",
    "cvv",
    "cvc",
    "2fa",
    "otp",
    "codigo",
    "code",
    "pin",
    "bank",
    "banco"
  ];
  const saveTimers = new Map();
  const AUTO_SUGGESTION_LIMIT = storage.MAX_FIELD_HISTORY || 10;
  let suggestionHost = null;
  let suggestionRoot = null;
  let suggestionList = null;
  let activeSuggestionElement = null;
  let suggestionRequestId = 0;
  let fieldSafetySettings = storage.normalizeSettings ? storage.normalizeSettings() : {
    allowUnsafeFields: false
  };
  let isApplyingSavedData = false;

  function getSiteKey() {
    return window.location.origin + window.location.pathname;
  }

  async function refreshSafetySettings() {
    fieldSafetySettings = await storage.getSettings();
    return fieldSafetySettings;
  }

  function getInputType(element) {
    if (element.tagName !== "INPUT") {
      return element.tagName.toLowerCase();
    }

    return (element.getAttribute("type") || "text").toLowerCase();
  }

  function escapeCss(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }

    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function escapeAttribute(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }

  function isUniqueSelector(selector, element) {
    try {
      const matches = Array.from(document.querySelectorAll(selector));
      return matches.length === 1 && (!element || matches[0] === element);
    } catch (error) {
      return false;
    }
  }

  function getAssociatedLabelText(element) {
    const texts = [];

    if (element.id) {
      const label = document.querySelector(`label[for='${escapeAttribute(element.id)}']`);

      if (label) {
        texts.push(label.textContent || "");
      }
    }

    const wrappingLabel = element.closest("label");

    if (wrappingLabel) {
      texts.push(wrappingLabel.textContent || "");
    }

    return texts.join(" ").trim();
  }

  function hasBlockedKeyword(element) {
    const values = [
      getInputType(element),
      element.id,
      element.name,
      element.autocomplete,
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
      element.getAttribute("data-testid"),
      element.getAttribute("data-test"),
      element.className ? String(element.className) : "",
      getAssociatedLabelText(element)
    ];
    const haystack = values.filter(Boolean).join(" ").toLowerCase();

    return BLOCKED_KEYWORDS.some((keyword) => haystack.includes(keyword));
  }

  function isVisibleElement(element) {
    if (element.hidden) {
      return false;
    }

    const style = window.getComputedStyle(element);

    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }

    return element.getClientRects().length > 0;
  }

  function isSafeInput(element) {
    if (!element || !ALLOWED_TAGS.has(element.tagName)) {
      return false;
    }

    if (element.disabled || element.readOnly) {
      return false;
    }

    if (fieldSafetySettings.allowUnsafeFields === true) {
      return true;
    }

    if (element.tagName === "INPUT" && BLOCKED_INPUT_TYPES.has(getInputType(element))) {
      return false;
    }

    if (hasBlockedKeyword(element)) {
      return false;
    }

    return true;
  }

  function selectorFromAttribute(element, attributeName) {
    const rawValue = element.getAttribute(attributeName);

    if (!rawValue) {
      return "";
    }

    const tagName = element.tagName.toLowerCase();
    const selector = `${tagName}[${attributeName}='${escapeAttribute(rawValue)}']`;

    return isUniqueSelector(selector, element) ? selector : "";
  }

  function getNthOfTypeSelector(element) {
    const parts = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      const tagName = current.tagName.toLowerCase();

      if (current.id) {
        const idSelector = `#${escapeCss(current.id)}`;

        if (isUniqueSelector(idSelector, current)) {
          parts.unshift(idSelector);
          break;
        }
      }

      const sameTagSiblings = Array.from(current.parentElement ? current.parentElement.children : [])
        .filter((sibling) => sibling.tagName === current.tagName);
      const index = sameTagSiblings.indexOf(current) + 1;
      parts.unshift(`${tagName}:nth-of-type(${index})`);

      const selector = parts.join(" > ");

      if (isUniqueSelector(selector, element)) {
        return selector;
      }

      current = current.parentElement;
    }

    return parts.join(" > ");
  }

  function generateSelector(element) {
    if (!element || !ALLOWED_TAGS.has(element.tagName)) {
      return "";
    }

    if (element.id) {
      const idSelector = `#${escapeCss(element.id)}`;

      if (isUniqueSelector(idSelector, element)) {
        return idSelector;
      }
    }

    const attributeSelectors = [
      selectorFromAttribute(element, "name"),
      selectorFromAttribute(element, "aria-label"),
      selectorFromAttribute(element, "placeholder"),
      selectorFromAttribute(element, "data-testid"),
      selectorFromAttribute(element, "data-test")
    ].filter(Boolean);

    if (attributeSelectors.length > 0) {
      return attributeSelectors[0];
    }

    return getNthOfTypeSelector(element);
  }

  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(element, value);
      return;
    }

    element.value = value;
  }

  function fillInput(element, value) {
    if (!isSafeInput(element)) {
      return false;
    }

    const nextValue = String(value ?? "");

    if (element.tagName === "INPUT" && getInputType(element) === "file") {
      return false;
    }

    if (element.tagName === "SELECT") {
      const matchingOption = Array.from(element.options).find((option) => (
        option.value === nextValue || option.text.trim() === nextValue
      ));
      element.value = matchingOption ? matchingOption.value : nextValue;
    } else {
      setNativeValue(element, nextValue);
    }

    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return true;
  }

  function selectorTargetsElement(selector, element) {
    try {
      return Array.from(document.querySelectorAll(selector)).includes(element);
    } catch (error) {
      return false;
    }
  }

  function toSuggestionTimestamp(value) {
    const timestamp = Date.parse(value || "");
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function sortSuggestions(suggestions) {
    return suggestions.slice().sort((first, second) => {
      if (second.useCount !== first.useCount) {
        return second.useCount - first.useCount;
      }

      return toSuggestionTimestamp(second.lastUsedAt) - toSuggestionTimestamp(first.lastUsedAt);
    });
  }

  function addSuggestionValue(suggestions, seenValues, suggestion) {
    const textValue = String(suggestion.value ?? "");
    const key = `${suggestion.kind}:${suggestion.ruleId || suggestion.selector || ""}:${textValue}`;

    if (textValue === "" || seenValues.has(key)) {
      return;
    }

    seenValues.add(key);
    suggestions.push({
      ...suggestion,
      value: textValue,
      useCount: Number.isFinite(Number(suggestion.useCount)) ? Number(suggestion.useCount) : 0,
      lastUsedAt: suggestion.lastUsedAt || ""
    });
  }

  async function getSuggestionsForInput(element) {
    if (!isSafeInput(element)) {
      return [];
    }

    const selector = generateSelector(element);

    if (!selector) {
      return [];
    }

    const siteData = await storage.getSiteData(getSiteKey());
    const autoSuggestions = [];
    const manualSuggestions = [];
    const seenAutoValues = new Set();
    const seenManualValues = new Set();
    const savedField = siteData.autoCapturedFields[selector];

    if (savedField && savedField.enabled !== false) {
      if (Array.isArray(savedField.history)) {
        savedField.history.forEach((entry) => {
          addSuggestionValue(autoSuggestions, seenAutoValues, {
            kind: "auto",
            selector,
            value: entry.value,
            sourceLabel: "Autoguardado",
            useCount: entry.useCount,
            lastUsedAt: entry.lastUsedAt
          });
        });
      } else {
        addSuggestionValue(autoSuggestions, seenAutoValues, {
          kind: "auto",
          selector,
          value: savedField.value,
          sourceLabel: "Autoguardado",
          useCount: 0,
          lastUsedAt: savedField.lastUpdated || ""
        });
      }
    }

    (siteData.manualRules || []).forEach((rule) => {
      if (!rule || rule.enabled === false || !rule.selector) {
        return;
      }

      if (rule.selector === selector || selectorTargetsElement(rule.selector, element)) {
        addSuggestionValue(manualSuggestions, seenManualValues, {
          kind: "manual",
          ruleId: rule.id,
          selector: rule.selector,
          value: rule.value,
          sourceLabel: rule.label || "Regla manual",
          useCount: rule.useCount,
          lastUsedAt: rule.lastUsedAt
        });
      }
    });

    return [
      ...sortSuggestions(manualSuggestions),
      ...sortSuggestions(autoSuggestions).slice(0, AUTO_SUGGESTION_LIMIT)
    ];
  }

  function ensureSuggestionHost() {
    if (suggestionHost && suggestionList) {
      return;
    }

    suggestionHost = document.createElement("div");
    suggestionHost.id = "work-input-autofill-suggestions";
    suggestionHost.style.position = "fixed";
    suggestionHost.style.zIndex = "2147483647";
    suggestionHost.style.display = "none";
    suggestionHost.style.left = "0";
    suggestionHost.style.top = "0";
    suggestionHost.style.width = "280px";

    suggestionRoot = suggestionHost.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        color-scheme: light;
        font-family: Arial, Helvetica, sans-serif;
      }

      .panel {
        overflow: hidden;
        border: 1px solid #cfd8dc;
        border-radius: 8px;
        background: #ffffff;
        box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18);
      }

      .header {
        border-bottom: 1px solid #e5ecef;
        background: #f6faf9;
        color: #0f5f58;
        font-size: 12px;
        font-weight: 700;
        padding: 8px 10px;
      }

      .list {
        display: grid;
        max-height: 232px;
        overflow-y: auto;
      }

      .item {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 34px;
        border-bottom: 1px solid #edf1f3;
      }

      .item:last-child {
        border-bottom: 0;
      }

      button {
        all: unset;
        cursor: pointer;
      }

      button:hover,
      button:focus {
        background: #eef7f5;
      }

      .fill {
        display: grid;
        gap: 2px;
        min-width: 0;
        padding: 9px 10px;
      }

      .delete {
        align-items: center;
        color: #b42318;
        display: flex;
        font-size: 18px;
        font-weight: 700;
        justify-content: center;
      }

      .delete:hover,
      .delete:focus {
        background: #fff0ed;
      }

      .value {
        overflow: hidden;
        color: #172026;
        font-size: 13px;
        line-height: 1.25;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .source {
        color: #64727c;
        font-size: 11px;
        line-height: 1.25;
      }
    `;

    const panel = document.createElement("div");
    panel.className = "panel";

    const header = document.createElement("div");
    header.className = "header";
    header.textContent = "Selecciona un valor guardado";

    suggestionList = document.createElement("div");
    suggestionList.className = "list";

    panel.append(header, suggestionList);
    suggestionRoot.append(style, panel);
    document.documentElement.append(suggestionHost);
  }

  function positionSuggestionHost(element) {
    if (!suggestionHost || !element) {
      return;
    }

    const rect = element.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 280), window.innerWidth - 16);
    const left = Math.min(Math.max(rect.left, 8), Math.max(8, window.innerWidth - width - 8));
    const belowTop = rect.bottom + 6;
    const aboveTop = Math.max(8, rect.top - 246);
    const top = window.innerHeight - belowTop < 180 && rect.top > 246 ? aboveTop : belowTop;

    suggestionHost.style.width = `${width}px`;
    suggestionHost.style.left = `${left}px`;
    suggestionHost.style.top = `${Math.min(top, window.innerHeight - 48)}px`;
  }

  function hideSuggestions() {
    activeSuggestionElement = null;

    if (suggestionHost) {
      suggestionHost.style.display = "none";
    }
  }

  async function markSuggestionUsed(suggestion) {
    if (suggestion.kind === "manual" && suggestion.ruleId) {
      await storage.markManualRuleUsed(getSiteKey(), suggestion.ruleId);
      return;
    }

    if (suggestion.kind === "auto" && suggestion.selector) {
      await storage.markAutoCapturedValueUsed(getSiteKey(), suggestion.selector, suggestion.value);
    }
  }

  async function deleteSuggestion(suggestion) {
    if (suggestion.kind === "manual" && suggestion.ruleId) {
      await storage.deleteManualRule(getSiteKey(), suggestion.ruleId);
      return;
    }

    if (suggestion.kind === "auto" && suggestion.selector) {
      await storage.deleteAutoCapturedValue(getSiteKey(), suggestion.selector, suggestion.value);
    }
  }

  async function applySuggestionValue(suggestion) {
    if (!activeSuggestionElement || !isSafeInput(activeSuggestionElement)) {
      hideSuggestions();
      return;
    }

    isApplyingSavedData = true;

    try {
      fillInput(activeSuggestionElement, suggestion.value);
    } finally {
      isApplyingSavedData = false;
    }

    try {
      await markSuggestionUsed(suggestion);
    } catch (error) {
      console.error("Could not update autofill suggestion usage.", error);
    }

    activeSuggestionElement.focus();
    hideSuggestions();
  }

  async function deleteSuggestionValue(suggestion) {
    const element = activeSuggestionElement;

    try {
      await deleteSuggestion(suggestion);

      if (element && document.contains(element) && document.activeElement === element) {
        showSuggestionsForInput(element);
      } else {
        hideSuggestions();
      }
    } catch (error) {
      console.error("Could not delete autofill suggestion.", error);
    }
  }

  function renderSuggestions(element, suggestions) {
    if (suggestions.length === 0) {
      hideSuggestions();
      return;
    }

    ensureSuggestionHost();
    suggestionList.replaceChildren();

    suggestions.forEach((suggestion) => {
      const item = document.createElement("div");
      item.className = "item";

      const fillButton = document.createElement("button");
      fillButton.type = "button";
      fillButton.className = "fill";
      fillButton.title = suggestion.value;

      const value = document.createElement("span");
      value.className = "value";
      value.textContent = suggestion.value;

      const source = document.createElement("span");
      source.className = "source";
      source.textContent = suggestion.sourceLabel;

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "delete";
      deleteButton.title = "Eliminar sugerencia";
      deleteButton.textContent = "x";

      fillButton.append(value, source);
      fillButton.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        applySuggestionValue(suggestion).catch((error) => {
          console.error("Could not apply autofill suggestion.", error);
        });
      });
      deleteButton.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        deleteSuggestionValue(suggestion);
      });

      item.append(fillButton, deleteButton);
      suggestionList.append(item);
    });

    activeSuggestionElement = element;
    positionSuggestionHost(element);
    suggestionHost.style.display = "block";
  }

  async function showSuggestionsForInput(element) {
    if (!isSafeInput(element)) {
      hideSuggestions();
      return;
    }

    const requestId = suggestionRequestId + 1;
    suggestionRequestId = requestId;

    try {
      const suggestions = await getSuggestionsForInput(element);

      if (requestId !== suggestionRequestId || document.activeElement !== element) {
        return;
      }

      renderSuggestions(element, suggestions);
    } catch (error) {
      console.error("Could not load autofill suggestions.", error);
      hideSuggestions();
    }
  }

  function handleInputFocus(event) {
    const element = event.target;

    if (!isSafeInput(element)) {
      hideSuggestions();
      return;
    }

    showSuggestionsForInput(element);
  }

  function handleDocumentPointerDown(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];

    if (suggestionHost && path.includes(suggestionHost)) {
      return;
    }

    if (activeSuggestionElement && event.target === activeSuggestionElement) {
      return;
    }

    hideSuggestions();
  }

  function handleSuggestionKeydown(event) {
    if (event.key === "Escape") {
      hideSuggestions();
    }
  }

  function querySafeInput(selector) {
    try {
      const element = document.querySelector(selector);
      return isSafeInput(element) ? element : null;
    } catch (error) {
      return null;
    }
  }

  async function applySavedFields(siteData) {
    const fields = siteData.autoCapturedFields || {};
    let filledCount = 0;

    Object.values(fields).forEach((field) => {
      if (!field || field.enabled === false || !field.selector) {
        return;
      }

      const element = querySafeInput(field.selector);

      if (element && fillInput(element, field.value)) {
        filledCount += 1;
      }
    });

    return filledCount;
  }

  async function applyManualRules(siteData) {
    const rules = Array.isArray(siteData.manualRules) ? siteData.manualRules : [];
    let filledCount = 0;

    rules.forEach((rule) => {
      if (!rule || rule.enabled === false || !rule.selector) {
        return;
      }

      const element = querySafeInput(rule.selector);

      if (element && fillInput(element, rule.value)) {
        filledCount += 1;
      }
    });

    return filledCount;
  }

  async function applyAllSavedFields() {
    await refreshSafetySettings();
    const siteData = await storage.getSiteData(getSiteKey());
    isApplyingSavedData = true;

    try {
      const autoFilledCount = await applySavedFields(siteData);
      const manualFilledCount = await applyManualRules(siteData);

      return {
        autoFilledCount,
        manualFilledCount,
        totalFilledCount: autoFilledCount + manualFilledCount
      };
    } finally {
      isApplyingSavedData = false;
    }
  }

  async function saveAutoCapturedField(element) {
    if (!isSafeInput(element)) {
      return;
    }

    const selector = generateSelector(element);

    if (!selector) {
      return;
    }

    await storage.upsertAutoCapturedField(getSiteKey(), {
      selector,
      value: element.value,
      lastUpdated: new Date().toISOString(),
      enabled: true,
      source: "auto"
    });
  }

  function scheduleSave(element) {
    const selector = generateSelector(element);

    if (!selector) {
      return;
    }

    if (saveTimers.has(selector)) {
      window.clearTimeout(saveTimers.get(selector));
    }

    saveTimers.set(selector, window.setTimeout(() => {
      saveTimers.delete(selector);
      saveAutoCapturedField(element).catch((error) => {
        console.error("Could not save autofill field.", error);
      });
    }, 300));
  }

  function handleInputChange(event) {
    if (isApplyingSavedData) {
      return;
    }

    if (event.type === "input") {
      return;
    }

    const element = event.target;

    if (!isSafeInput(element)) {
      return;
    }

    scheduleSave(element);
  }

  function detectLabel(element, fallbackSelector) {
    const labelText = getAssociatedLabelText(element);

    if (labelText) {
      return labelText.replace(/\s+/g, " ").trim();
    }

    return element.getAttribute("aria-label")
      || element.getAttribute("placeholder")
      || element.name
      || element.id
      || fallbackSelector;
  }

  function scanInputs() {
    const elements = Array.from(document.querySelectorAll("input, textarea, select"));
    const seenSelectors = new Set();

    return elements
      .filter((element) => isSafeInput(element) && (
        fieldSafetySettings.allowUnsafeFields === true || isVisibleElement(element)
      ))
      .map((element) => {
        const selector = generateSelector(element);

        return {
          selector,
          label: detectLabel(element, selector),
          tagName: element.tagName.toLowerCase(),
          type: getInputType(element),
          value: element.value || "",
          enabled: true
        };
      })
      .filter((item) => {
        if (!item.selector || seenSelectors.has(item.selector)) {
          return false;
        }

        seenSelectors.add(item.selector);
        return true;
      });
  }

  function testSelector(selector) {
    try {
      const matches = Array.from(document.querySelectorAll(selector || ""));
      const safeMatches = matches.filter((element) => isSafeInput(element));

      return {
        isValid: true,
        matchCount: matches.length,
        safeMatchCount: safeMatches.length
      };
    } catch (error) {
      return {
        isValid: false,
        matchCount: 0,
        safeMatchCount: 0,
        error: error.message
      };
    }
  }

  function scheduleInitialAutofill() {
    [0, 750, 2000].forEach((delay) => {
      window.setTimeout(() => {
        applyAllSavedFields().catch((error) => {
          console.error("Could not apply saved autofill data.", error);
        });
      }, delay);
    });
  }

  document.addEventListener("input", handleInputChange, true);
  document.addEventListener("change", handleInputChange, true);
  document.addEventListener("focusout", handleInputChange, true);
  document.addEventListener("focusin", handleInputFocus, true);
  document.addEventListener("click", handleInputFocus, true);
  document.addEventListener("pointerdown", handleDocumentPointerDown, true);
  document.addEventListener("keydown", handleSuggestionKeydown, true);
  document.addEventListener("scroll", () => {
    if (activeSuggestionElement && suggestionHost && suggestionHost.style.display !== "none") {
      positionSuggestionHost(activeSuggestionElement);
    }
  }, true);
  window.addEventListener("resize", () => {
    if (activeSuggestionElement && suggestionHost && suggestionHost.style.display !== "none") {
      positionSuggestionHost(activeSuggestionElement);
    }
  });

  refreshSafetySettings().catch((error) => {
    console.error("Could not load autofill safety settings.", error);
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scheduleInitialAutofill, { once: true });
  } else {
    scheduleInitialAutofill();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) {
      return false;
    }

    if (message.type === "GET_SITE_KEY") {
      sendResponse({ ok: true, siteKey: getSiteKey() });
      return false;
    }

    if (message.type === "SCAN_INPUTS") {
      refreshSafetySettings()
        .then(() => sendResponse({ ok: true, siteKey: getSiteKey(), inputs: scanInputs() }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));

      return true;
    }

    if (message.type === "TEST_SELECTOR") {
      refreshSafetySettings()
        .then(() => sendResponse({ ok: true, result: testSelector(message.selector) }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));

      return true;
    }

    if (message.type === "SETTINGS_CHANGED") {
      fieldSafetySettings = storage.normalizeSettings(message.settings);
      sendResponse({ ok: true, settings: fieldSafetySettings });
      return false;
    }

    if (message.type === "FILL_NOW") {
      applyAllSavedFields()
        .then((result) => sendResponse({ ok: true, siteKey: getSiteKey(), result }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));

      return true;
    }

    return false;
  });

  window.WorkInputAutofill = {
    getSiteKey,
    isSafeInput,
    generateSelector,
    fillInput,
    getSuggestionsForInput,
    applySavedFields,
    applyManualRules,
    scanInputs,
    saveAutoCapturedField
  };
})();
