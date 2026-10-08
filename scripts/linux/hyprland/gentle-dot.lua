-- Gentle Dot on Hyprland with a Lua config (Omarchy 4, Hyprland 0.55 and later).
-- Hyprland does not let apps place their own windows or stay on top, so these rules do it:
-- the rose floats at the right edge on every workspace, and the panel opens next to it.
-- Paste this at the end of ~/.config/hypr/hyprland.lua, or copy the file to
-- ~/.config/hypr/gentle-dot.lua and add `require("hypr.gentle-dot")` at the end of hyprland.lua.
-- Using hyprland.conf instead? See gentle-dot.conf next to this file.

local toggle = (os.getenv("HOME") or "") .. "/.local/bin/gentle-dot --toggle"

-- The rose: a 72 px transparent window with no border, shadow, or blur.
hl.window_rule({
  match = { title = "^(Gentle Dot)$" },
  tag = "-default-opacity", -- Omarchy's default window opacity; harmless elsewhere
  float = true,
  pin = true,
  size = { 72, 72 },
  move = { "(monitor_w-window_w-12)", "((monitor_h-window_h)*0.5)" },
  border_size = 0,
  rounding = 0,
  no_shadow = true,
  no_blur = true,
  no_initial_focus = true,
  opacity = "1 override 1 override",
})

-- The panel: floating and pinned, left of the rose.
hl.window_rule({
  match = { title = "^(Gentle Dot Panel)$" },
  tag = "-default-opacity",
  float = true,
  pin = true,
  size = { 420, 640 },
  move = { "(monitor_w-window_w-92)", "((monitor_h-window_h)*0.5)" },
  border_size = 0,
  no_shadow = true,
  no_blur = true,
  opacity = "1 override 1 override",
})

-- SUPER + ALT + D toggles the panel. Omarchy's o.bind also lists it in its keybindings menu.
local omarchy = rawget(_G, "o")
if omarchy and omarchy.bind then
  omarchy.bind("SUPER + ALT + D", "Gentle Dot", toggle)
else
  hl.bind("SUPER + ALT + D", hl.dsp.exec_cmd(toggle))
end
