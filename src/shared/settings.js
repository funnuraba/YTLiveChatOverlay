(() => {
  "use strict";

  if (globalThis.__YT_LIVE_OVERLAY_SETTINGS__) {
    return;
  }

  const schema = Object.freeze({
    x: Object.freeze({ defaultValue: 82, min: 10, max: 90, step: 0.1, unit: "%" }),
    y: Object.freeze({ defaultValue: 45, min: 10, max: 90, step: 0.1, unit: "%" }),
    width: Object.freeze({ defaultValue: 420, min: 240, max: 800, step: 1, unit: "px" }),
    height: Object.freeze({ defaultValue: 70, min: 25, max: 90, step: 0.1, unit: "vh" }),
    fontSize: Object.freeze({ defaultValue: 16, min: 12, max: 32, step: 1, unit: "px" }),
    backgroundOpacity: Object.freeze({ defaultValue: 58, min: 0, max: 90, step: 1, unit: "%" })
  });

  const defaults = Object.freeze(Object.fromEntries(
    Object.entries(schema).map(([key, definition]) => [key, definition.defaultValue])
  ));

  function normalize(input = {}) {
    return Object.fromEntries(Object.entries(schema).map(([key, definition]) => {
      const value = Number(input[key]);
      const finiteValue = Number.isFinite(value) ? value : definition.defaultValue;
      const clampedValue = Math.min(definition.max, Math.max(definition.min, finiteValue));
      const precision = String(definition.step).split(".")[1]?.length ?? 0;
      const steppedValue = Number(
        (Math.round(clampedValue / definition.step) * definition.step).toFixed(precision)
      );
      return [key, steppedValue];
    }));
  }

  globalThis.__YT_LIVE_OVERLAY_SETTINGS__ = Object.freeze({
    storageKey: "overlaySettings",
    schema,
    defaults,
    normalize
  });
})();
