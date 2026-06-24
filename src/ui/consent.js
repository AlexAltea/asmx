/*
 * Cookie-consent banner. The gtag loader and the `consent default` (denied)
 * live in index.html <head> so they run before GA processes the first hit;
 * this only renders the prompt and, on Accept, flips analytics_storage on.
 * The stored choice (key mirrored in the head script) suppresses the banner on
 * later visits and seeds that default.
 */
import { el } from "./dom.js";

const LS_KEY = "asmx-consent";

export function initConsent() {
    let choice = null;
    try {
        choice = localStorage.getItem(LS_KEY);
    } catch {}
    if (choice) return; // already accepted or declined

    const bar = el("div", "consent");
    const msg = el("p");
    msg.textContent = "We use analytics cookies to understand usage.";
    const decline = el("button", "btn");
    decline.textContent = "Decline";
    const accept = el("button", "btn primary blue");
    accept.textContent = "Accept";
    bar.append(msg, decline, accept);

    const choose = (value) => {
        try {
            localStorage.setItem(LS_KEY, value);
        } catch {}
        if (value === "granted") window.gtag?.("consent", "update", { analytics_storage: "granted" });
        bar.remove();
    };
    decline.onclick = () => choose("denied");
    accept.onclick = () => choose("granted");
    document.body.appendChild(bar);
}
