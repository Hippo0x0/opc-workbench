import { useEffect, useRef, useState } from "react";
import "./theme.css";

type Appearance = "light" | "dark" | "system";
const storageKey = "opc-workbench-appearance";
const choices: Array<{ value: Appearance; label: string }> = [
  { value: "light", label: "浅色" }, { value: "dark", label: "深色" }, { value: "system", label: "跟随系统" },
];
function readAppearance(): Appearance {
  try { const value = localStorage.getItem(storageKey); return value === "light" || value === "dark" ? value : "system"; }
  catch { return "system"; }
}
function applyAppearance(value: Appearance): void {
  document.documentElement.dataset.theme = value === "system"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" : value;
}
function ThemeIcon({ mode }: { mode: Appearance }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {mode === "light" ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5" /></>
      : mode === "dark" ? <path d="M20 14.3A8.5 8.5 0 0 1 9.7 4 8.5 8.5 0 1 0 20 14.3Z" />
        : <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></>}
  </svg>;
}

export function ThemeSwitcher() {
  const [appearance, setAppearance] = useState<Appearance>(readAppearance);
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  useEffect(() => {
    applyAppearance(appearance);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => { if (appearance === "system") applyAppearance("system"); };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [appearance]);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (details.current && event.target instanceof Node && !details.current.contains(event.target)) details.current.open = false; };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && details.current?.open) { details.current.open = false; summary.current?.focus(); } };
    const sync = (event: StorageEvent) => { if (event.key === storageKey || event.key === null) setAppearance(readAppearance()); };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape); window.addEventListener("storage", sync);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); window.removeEventListener("storage", sync); };
  }, []);
  return <details className="theme-switcher" ref={details}>
    <summary ref={summary} aria-label="外观设置" title={`外观：${choices.find(choice => choice.value === appearance)?.label}`}><ThemeIcon mode={appearance} /><span>{choices.find(choice => choice.value === appearance)?.label}</span></summary>
    <div className="theme-options" role="group" aria-label="外观模式">{choices.map(choice => <button type="button" key={choice.value} aria-pressed={appearance === choice.value} onClick={() => {
      setAppearance(choice.value); applyAppearance(choice.value);
      try { localStorage.setItem(storageKey, choice.value); } catch { /* 浏览器禁用存储时仍可切换当前页面。 */ }
      if (details.current) details.current.open = false;
      summary.current?.focus();
    }}><ThemeIcon mode={choice.value} /><span>{choice.label}</span><span className="theme-check" aria-hidden="true">{appearance === choice.value ? "✓" : ""}</span></button>)}</div>
  </details>;
}
