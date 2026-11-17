/**
 * Lightweight i18n for the Image Converter plugin.
 *
 * Design: the English source string is used as the translation key.
 * - In English mode, t() returns the key unchanged (no English dictionary needed).
 * - In Chinese mode, t() looks the key up in the zh-CN dictionary.
 *
 * Interpolation: pass a params object and use {name} placeholders in the key,
 * e.g. t('Failed to process "{file}"', { file: name }).
 */

import { zhCN } from "./zh-CN";

export type Language = "en" | "zh-cn";

export const SUPPORTED_LANGUAGES: { value: Language; label: string }[] = [
    { value: "en", label: "English" },
    { value: "zh-cn", label: "简体中文" },
];

let currentLanguage: Language = "en";

const dictionaries: Record<Language, Record<string, string> | undefined> = {
    en: undefined, // English is the source language; keys are returned as-is.
    // eslint-disable-next-line @typescript-eslint/naming-convention -- locale code contains a hyphen
    "zh-cn": zhCN,
};

/** Set the active language. Call this right after settings are loaded. */
export function setLanguage(language: string | undefined | null): void {
    currentLanguage = language === "zh-cn" ? "zh-cn" : "en";
}

/** Get the active language. */
export function getLanguage(): Language {
    return currentLanguage;
}

/**
 * Detect a sensible default language from Obsidian's UI language.
 * Returns "zh-cn" when the UI language starts with "zh", otherwise "en".
 */
export function detectSystemLanguage(): Language {
    try {
        // Obsidian exposes the current locale via moment / navigator.
        const uiLang =
            (window as unknown as { moment?: { locale?: () => string } }).moment?.locale?.() ??
            window.navigator.language ??
            "en";
        return uiLang.toLowerCase().startsWith("zh") ? "zh-cn" : "en";
    } catch {
        return "en";
    }
}

/**
 * Translate a user-facing string.
 *
 * @param key The English source string (also the dictionary key).
 * @param params Optional values for {placeholder} interpolation.
 */
export function t(key: string, params?: Record<string, string | number>): string {
    let result = key;
    if (currentLanguage === "zh-cn") {
        const dict = dictionaries["zh-cn"];
        const translated = dict?.[key];
        if (translated !== undefined) {
            result = translated;
        }
    }
    if (params) {
        for (const [name, value] of Object.entries(params)) {
            result = result.replace(new RegExp(`\\{${name}\\}`, "g"), String(value));
        }
    }
    return result;
}
