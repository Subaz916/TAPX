assets/sounds/
=============

TAPX does not need any audio files.

The tap, combo, critical, reward, level-up and error sounds are generated at
runtime with the Web Audio API in js/ui.js (the `Audio` helper). Nothing is
downloaded, so the game works offline and there is no audio licensing to worry
about.

Turning sounds off
------------------
Settings -> Sound (or set `CONFIG` / the `tapx.sound` localStorage key to false).
The preference is stored per account in `game_state.sound_enabled`.

Adding your own sounds (optional)
---------------------------------
If you want to replace the synthesised sounds with real files, drop them in this
folder, e.g.

    tap.wav
    combo.wav
    crit.wav
    reward.wav
    levelup.wav
    error.wav

then extend the `play(kind)` function in js/ui.js to fetch the matching file and
pass it to an AudioBufferSourceNode. Keep the files short and small; large
files slow down the first tap on mobile.

Note: sounds are a convenience. They must never be required for gameplay, and
they must never play automatically before the user interacts with the page
(browsers block audio until the first gesture).
