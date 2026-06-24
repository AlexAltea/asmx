// Unit test for ui/slide.js, the cosmetic row-slide helper. The animation itself
// is compositor work (verified in a browser), but the decision logic (snap vs
// animate, supersede, cancel, reduced-motion) is pinned here with a fake wrapper
// whose animate() is a controllable stub. Run: node test_slide.mjs

let pass = 0,
    fail = 0;
function ok(cond, msg) {
    if (cond) pass++;
    else {
        fail++;
        console.error("  ✗ " + msg);
    }
}

// ---- minimal Web Animations stub the module touches ----------------------
function fakeWrap() {
    return {
        style: {},
        anims: [],
        animate(keyframes, opts) {
            let resolve, reject;
            const anim = {
                keyframes,
                opts,
                canceled: false,
                finished: new Promise((res, rej) => ((resolve = res), (reject = rej))),
                finish: () => resolve(),
                cancel() {
                    this.canceled = true;
                    reject(new Error("canceled"));
                },
            };
            this.anims.push(anim);
            return anim;
        },
    };
}
const settle = () => new Promise((r) => setTimeout(r)); // let `finished` handlers run

// matchMedia unset -> reduce=false for the default (animating) module instance.
const { slideRows, slideCancel } = await import("../src/ui/slide.js");

// --- snap: delta beyond maxPx -------------------------------------------
{
    const w = fakeWrap();
    let done = 0;
    slideRows(w, 100, 0, { maxPx: 50, onDone: () => done++ });
    ok(w.style.transform === "translateY(0px)", "cap: snaps to resting transform");
    ok(done === 1, "cap: onDone fired synchronously");
    ok(!w._slide && w.anims.length === 0, "cap: no tween armed");
}

// --- snap: zero delta ----------------------------------------------------
{
    const w = fakeWrap();
    let done = 0;
    slideRows(w, 7, 7, { onDone: () => done++ });
    ok(w.style.transform === "translateY(7px)", "zero: rests at toPx");
    ok(done === 1 && !w._slide && w.anims.length === 0, "zero: onDone sync, no tween");
}

// --- animate: in-range plays a tween over the resting transform ----------
{
    const w = fakeWrap();
    let done = 0;
    slideRows(w, 30, 0, { maxPx: 50, onDone: () => done++ });
    ok(w.style.transform === "translateY(0px)", "arm: inline style is the resting transform");
    const a = w.anims[0];
    ok(!!a && w._slide === a, "arm: tween stored on the wrapper");
    ok(String(a.keyframes.transform) === "translateY(30px),translateY(0px)", "arm: keyframes run from -> to");
    ok(a.opts.duration === 110, "arm: ~110ms duration");
    ok(done === 0, "arm: onDone deferred");
    a.finish();
    await settle();
    ok(done === 1, "settle: onDone fired on finish");
    ok(!w._slide, "settle: state cleared");
}

// --- slideCancel finalizes without running onDone -----------------------
{
    const w = fakeWrap();
    let done = 0;
    slideRows(w, 25, 0, { onDone: () => done++ });
    ok(!!w._slide, "cancel: armed first");
    slideCancel(w);
    ok(!w._slide && w.anims[0].canceled, "cancel: state cleared + tween cancelled");
    ok(w.style.transform === "translateY(0px)", "cancel: wrapper rests at toPx");
    await settle();
    ok(done === 0, "cancel: onDone NOT called (it would be stale)");
}

// --- a new slide supersedes the previous (no stacked tweens) ------------
{
    const w = fakeWrap();
    let a = 0,
        b = 0;
    slideRows(w, 10, 0, { onDone: () => a++ });
    slideRows(w, 40, 0, { maxPx: 50, onDone: () => b++ });
    ok(w.anims[0].canceled && w._slide === w.anims[1], "supersede: a fresh tween replaced the old");
    w.anims[1].finish();
    await settle();
    ok(b === 1 && a === 0, "supersede: only the latest onDone fires");
}

// --- reduced motion: a fresh module instance with matchMedia=reduce snaps -
{
    globalThis.matchMedia = () => ({ matches: true });
    const mod = await import("../src/ui/slide.js?reduced");
    const w = fakeWrap();
    let done = 0;
    mod.slideRows(w, 30, 0, { maxPx: 50, onDone: () => done++ });
    ok(w.style.transform === "translateY(0px)", "reduced: snaps to rest");
    ok(done === 1 && !w._slide && w.anims.length === 0, "reduced: onDone sync, no tween");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
