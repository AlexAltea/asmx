const LS_KEY = "asmx.theme";
const apply = (theme) => document.documentElement.setAttribute("data-theme", theme);

export function initTheme() {
    apply(localStorage.getItem(LS_KEY) || "dark");
}

export function toggleTheme() {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    apply(next);
    try {
        localStorage.setItem(LS_KEY, next);
    } catch {}
}
