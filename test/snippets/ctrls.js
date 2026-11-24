// EVAL snippet: control buttons by their specific class, with visibility
[...document.querySelectorAll(".bpx-player-control-bottom-right > *, .bpx-player-control-bottom-left > *")]
  .map(x => [...x.classList].filter(c => c !== "bpx-player-ctrl-btn").join(".") + ":" + (x.offsetWidth > 0 ? "on" : "off") + (x.hasAttribute("data-control-collapsed") ? "(collapsed)" : ""))
