// Format.js

export function formatDuration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));

  if (total < 60) {
    return `${total} min`;
  }

  const hours = Math.floor(total / 60);
  const mins = total % 60;

  return mins ? `${hours} hr ${mins} min` : `${hours} hr`;
}

export function formatDistance(meters) {
  const value = Math.max(0, Number(meters) || 0);

  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)} km`;
  }

  return `${Math.round(value)} m`;
}

export function directionText(step) {
  if (!step) {
    return "Continue";
  }

  const type = step.type || "";
  const instruction = String(step.instruction || "").trim();
  const modifier = String(step.modifier || "").trim();
  const road = String(step.road || step.name || "").trim();

  // ORS already returns natural-language cycling/walking instructions such as
  // "Turn right onto Wissler Road". Prefer those whenever they are available.
  if (instruction) {
    return instruction;
  }

  if (type === "transit" && modifier && !step.route && !step.from && !step.to) {
    return modifier;
  }

  if (type === "arrive") {
    return "Arrive at your destination";
  }

  let text;

  if (type === "depart") {
    text = modifier ? `Start heading ${modifier}` : "Start";
  } else if (type === "turn") {
    text = modifier ? `Turn ${modifier}` : "Turn";
  } else if (type === "continue") {
    if (modifier === "straight") {
      text = "Continue straight";
    } else if (modifier === "keep left" || modifier === "keep right") {
      text = modifier.charAt(0).toUpperCase() + modifier.slice(1);
    } else {
      text = modifier ? `Continue ${modifier}` : "Continue";
    }
  } else if (type === "end of road") {
    text = modifier
      ? `At the end of the road, turn ${modifier}`
      : "At the end of the road";
  } else if (type === "u_turn") {
    text = "Make a U-turn";
  } else if (type === "roundabout") {
    text = "Enter the roundabout";
  } else if (type === "roundabout_exit") {
    text = "Exit the roundabout";
  } else if (type === "walk") {
    text = "Walk";
    if (step.to) {
      text += ` to ${step.to}`;
    }
  } else if (type === "transfer") {
    text = "Transfer";
    if (step.to) {
      text += ` at ${step.to}`;
    }
  } else if (type === "transit") {
    text = step.route ? `Take route ${step.route}` : "Take transit";

    if (step.headsign) {
      text += ` toward ${step.headsign}`;
    }

    if (step.from && step.to) {
      text += ` from ${step.from} to ${step.to}`;
    }
  } else {
    text = type
      ? type.replaceAll("_", " ").replace(/\b\w/g, char => char.toUpperCase())
      : "Continue";

    if (modifier) {
      text += ` ${modifier}`;
    }
  }

  if (
    road &&
    type !== "arrive" &&
    type !== "transit" &&
    type !== "walk" &&
    type !== "transfer"
  ) {
    text += ` onto ${road}`;
  }

  return text;
}
