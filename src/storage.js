(function exposeStorage(global) {
  "use strict";

  const STORAGE_ROOT_KEY = "siteAutofillData";
  const SETTINGS_KEY = "autofillSettings";
  const MAX_FIELD_HISTORY = 10;
  const DEFAULT_SETTINGS = {
    allowUnsafeFields: false
  };

  function getStorageArea() {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
      throw new Error("chrome.storage.local is not available.");
    }

    return chrome.storage.local;
  }

  function getRuntimeError() {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.lastError) {
      return null;
    }

    return chrome.runtime.lastError;
  }

  function getStorage(keys) {
    return new Promise((resolve, reject) => {
      getStorageArea().get(keys, (result) => {
        const error = getRuntimeError();

        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve(result);
      });
    });
  }

  function setStorage(items) {
    return new Promise((resolve, reject) => {
      getStorageArea().set(items, () => {
        const error = getRuntimeError();

        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve();
      });
    });
  }

  function createId() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }

    return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function toNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function toTimestamp(value) {
    const date = Date.parse(value || "");
    return Number.isFinite(date) ? date : 0;
  }

  function sortHistoryEntries(entries) {
    return entries.slice().sort((first, second) => {
      if (second.useCount !== first.useCount) {
        return second.useCount - first.useCount;
      }

      return toTimestamp(second.lastUsedAt) - toTimestamp(first.lastUsedAt);
    });
  }

  function normalizeHistoryEntry(entry) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      return {
        value: String(entry.value ?? ""),
        useCount: toNumber(entry.useCount),
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
  }

  function normalizeHistory(history, currentValue) {
    const byValue = new Map();
    const values = Array.isArray(history) ? history : [];

    values
      .map(normalizeHistoryEntry)
      .filter((entry) => entry.value !== "")
      .forEach((entry) => {
        const existing = byValue.get(entry.value);

        if (!existing || entry.useCount > existing.useCount) {
          byValue.set(entry.value, entry);
          return;
        }

        if (existing.useCount === entry.useCount && toTimestamp(entry.lastUsedAt) > toTimestamp(existing.lastUsedAt)) {
          byValue.set(entry.value, entry);
        }
      });

    const value = String(currentValue ?? "");

    if (value && !byValue.has(value)) {
      byValue.set(value, {
        value,
        useCount: 0,
        createdAt: "",
        lastUsedAt: ""
      });
    }

    return sortHistoryEntries(Array.from(byValue.values())).slice(0, MAX_FIELD_HISTORY);
  }

  function normalizeAutoCapturedField(field, selector) {
    const data = field || {};
    const value = String(data.value ?? "");

    return {
      selector: String(data.selector || selector || "").trim(),
      value,
      lastUpdated: data.lastUpdated || "",
      enabled: data.enabled !== false,
      source: data.source || "auto",
      history: normalizeHistory(data.history, value)
    };
  }

  function normalizeManualRule(rule) {
    const data = rule || {};
    const now = new Date().toISOString();

    return {
      id: data.id || createId(),
      label: String(data.label || "").trim(),
      selector: String(data.selector || "").trim(),
      value: String(data.value ?? ""),
      enabled: data.enabled !== false,
      createdAt: data.createdAt || now,
      updatedAt: data.updatedAt || data.createdAt || now,
      useCount: toNumber(data.useCount),
      lastUsedAt: data.lastUsedAt || ""
    };
  }

  function normalizeSiteData(siteData) {
    const data = siteData || {};
    const autoCapturedFields = {};

    Object.entries(data.autoCapturedFields || {}).forEach(([selector, field]) => {
      const normalizedField = normalizeAutoCapturedField(field, selector);

      if (normalizedField.selector) {
        autoCapturedFields[normalizedField.selector] = normalizedField;
      }
    });

    return {
      autoCapturedFields,
      manualRules: Array.isArray(data.manualRules) ? data.manualRules.map(normalizeManualRule) : []
    };
  }

  function normalizeSettings(settings) {
    const data = settings || {};

    return {
      ...DEFAULT_SETTINGS,
      allowUnsafeFields: data.allowUnsafeFields === true
    };
  }

  function ensureSiteData(allData, siteKey) {
    if (!allData[siteKey]) {
      allData[siteKey] = {
        autoCapturedFields: {},
        manualRules: []
      };
    }

    allData[siteKey] = normalizeSiteData(allData[siteKey]);
    return allData[siteKey];
  }

  function upsertHistoryValue(history, value, options = {}) {
    const now = options.now || new Date().toISOString();
    const nextValue = String(value ?? "");
    const byValue = new Map();

    normalizeHistory(history, "").forEach((entry) => {
      byValue.set(entry.value, { ...entry });
    });

    if (nextValue) {
      const entry = byValue.get(nextValue) || {
        value: nextValue,
        useCount: 0,
        createdAt: now,
        lastUsedAt: ""
      };

      if (options.incrementUseCount !== false) {
        entry.useCount += 1;
        entry.lastUsedAt = now;
      }

      if (!entry.createdAt) {
        entry.createdAt = now;
      }

      byValue.set(nextValue, entry);
    }

    return sortHistoryEntries(Array.from(byValue.values())).slice(0, MAX_FIELD_HISTORY);
  }

  async function getAllData() {
    const result = await getStorage([STORAGE_ROOT_KEY]);
    return result[STORAGE_ROOT_KEY] || {};
  }

  async function saveAllData(allData) {
    await setStorage({ [STORAGE_ROOT_KEY]: allData || {} });
  }

  async function getSettings() {
    const result = await getStorage([SETTINGS_KEY]);
    return normalizeSettings(result[SETTINGS_KEY]);
  }

  async function saveSettings(settings) {
    const nextSettings = normalizeSettings(settings);
    await setStorage({ [SETTINGS_KEY]: nextSettings });
    return nextSettings;
  }

  async function getSiteData(siteKey) {
    const allData = await getAllData();
    return normalizeSiteData(allData[siteKey]);
  }

  async function saveSiteData(siteKey, siteData) {
    const allData = await getAllData();
    allData[siteKey] = normalizeSiteData(siteData);
    await saveAllData(allData);
    return allData[siteKey];
  }

  async function upsertAutoCapturedField(siteKey, field) {
    const allData = await getAllData();
    const siteData = ensureSiteData(allData, siteKey);
    const now = new Date().toISOString();
    const selector = String(field.selector || "").trim();
    const existingField = normalizeAutoCapturedField(siteData.autoCapturedFields[selector], selector);
    const value = String(field.value ?? "");

    if (!selector) {
      throw new Error("A selector is required.");
    }

    siteData.autoCapturedFields[selector] = {
      selector,
      value,
      lastUpdated: field.lastUpdated || now,
      enabled: field.enabled !== false,
      source: "auto",
      history: upsertHistoryValue(existingField.history, value, {
        now,
        incrementUseCount: field.incrementUseCount !== false
      })
    };

    await saveAllData(allData);
    return siteData.autoCapturedFields[selector];
  }

  async function markAutoCapturedValueUsed(siteKey, selector, value) {
    const allData = await getAllData();
    const siteData = ensureSiteData(allData, siteKey);
    const fieldSelector = String(selector || "").trim();
    const existingField = normalizeAutoCapturedField(siteData.autoCapturedFields[fieldSelector], fieldSelector);
    const now = new Date().toISOString();

    if (!fieldSelector) {
      throw new Error("A selector is required.");
    }

    siteData.autoCapturedFields[fieldSelector] = {
      ...existingField,
      selector: fieldSelector,
      value: String(value ?? ""),
      lastUpdated: now,
      enabled: existingField.enabled !== false,
      source: "auto",
      history: upsertHistoryValue(existingField.history, value, {
        now,
        incrementUseCount: true
      })
    };

    await saveAllData(allData);
    return siteData.autoCapturedFields[fieldSelector];
  }

  async function deleteAutoCapturedValue(siteKey, selector, value) {
    const allData = await getAllData();
    const siteData = ensureSiteData(allData, siteKey);
    const fieldSelector = String(selector || "").trim();
    const field = normalizeAutoCapturedField(siteData.autoCapturedFields[fieldSelector], fieldSelector);
    const valueToDelete = String(value ?? "");

    if (!fieldSelector || !siteData.autoCapturedFields[fieldSelector]) {
      return;
    }

    field.history = field.history.filter((entry) => entry.value !== valueToDelete);

    if (field.value === valueToDelete) {
      field.value = field.history[0] ? field.history[0].value : "";
    }

    if (field.history.length === 0 && !field.value) {
      delete siteData.autoCapturedFields[fieldSelector];
    } else {
      siteData.autoCapturedFields[fieldSelector] = field;
    }

    await saveAllData(allData);
  }

  async function upsertManualRule(siteKey, rule) {
    const allData = await getAllData();
    const siteData = ensureSiteData(allData, siteKey);
    const now = new Date().toISOString();
    const id = rule.id || createId();
    const existingRule = siteData.manualRules.find((item) => item.id === id);
    const nextRule = {
      id,
      label: String(rule.label || "").trim(),
      selector: String(rule.selector || "").trim(),
      value: String(rule.value ?? ""),
      enabled: rule.enabled !== false,
      createdAt: existingRule ? existingRule.createdAt : rule.createdAt || now,
      updatedAt: now,
      useCount: toNumber(rule.useCount, existingRule ? toNumber(existingRule.useCount) : 0),
      lastUsedAt: rule.lastUsedAt || (existingRule ? existingRule.lastUsedAt : "")
    };

    if (!nextRule.label || nextRule.label.length < 2) {
      throw new Error("The label must have at least 2 characters.");
    }

    if (!nextRule.selector) {
      throw new Error("A selector is required.");
    }

    if (existingRule) {
      siteData.manualRules = siteData.manualRules.map((item) => (
        item.id === id ? nextRule : item
      ));
    } else {
      siteData.manualRules.push(nextRule);
    }

    await saveAllData(allData);
    return nextRule;
  }

  async function markManualRuleUsed(siteKey, ruleId) {
    const allData = await getAllData();
    const siteData = ensureSiteData(allData, siteKey);
    const now = new Date().toISOString();
    let updatedRule = null;

    siteData.manualRules = siteData.manualRules.map((rule) => {
      if (rule.id !== ruleId) {
        return rule;
      }

      updatedRule = {
        ...rule,
        useCount: toNumber(rule.useCount) + 1,
        lastUsedAt: now,
        updatedAt: now
      };

      return updatedRule;
    });

    await saveAllData(allData);
    return updatedRule;
  }

  async function deleteManualRule(siteKey, ruleId) {
    const allData = await getAllData();
    const siteData = ensureSiteData(allData, siteKey);
    siteData.manualRules = siteData.manualRules.filter((rule) => rule.id !== ruleId);
    await saveAllData(allData);
  }

  async function deleteAutoCapturedField(siteKey, selector) {
    const allData = await getAllData();
    const siteData = ensureSiteData(allData, siteKey);
    delete siteData.autoCapturedFields[selector];
    await saveAllData(allData);
  }

  global.AutofillStorage = {
    STORAGE_ROOT_KEY,
    SETTINGS_KEY,
    MAX_FIELD_HISTORY,
    createId,
    getAllData,
    saveAllData,
    getSettings,
    saveSettings,
    getSiteData,
    saveSiteData,
    upsertAutoCapturedField,
    markAutoCapturedValueUsed,
    deleteAutoCapturedValue,
    upsertManualRule,
    markManualRuleUsed,
    deleteManualRule,
    deleteAutoCapturedField,
    normalizeSiteData,
    normalizeSettings
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
