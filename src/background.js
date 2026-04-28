"use strict";

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["siteAutofillData", "autofillSettings"], (result) => {
    const updates = {};

    if (!result.siteAutofillData) {
      updates.siteAutofillData = {};
    }

    if (!result.autofillSettings) {
      updates.autofillSettings = {
        allowUnsafeFields: false
      };
    }

    if (Object.keys(updates).length > 0) {
      chrome.storage.local.set(updates);
    }
  });
});
