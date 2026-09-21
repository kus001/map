// Format.js

export function formatDuration(minutes) {
  const total = Math.round(minutes);

  if (total < 60) {
    return `${total} min`;
  }

  const hours = Math.floor(total / 60);
  const mins = total % 60;

  return mins ? `${hours} hr ${mins} min` : `${hours} hr`;
}

export function directionText(step) {
  if (step.instruction) {
    return step.instruction;
  }

  const type = step.type || "";
  const modifier = step.modifier || "";
  const road = step.road || "";

  if (type === "arrive") {
    return "Arrive at your destination";
  }

  let text = "";

  if (type === "depart") {
    text = modifier ? `Start heading ${modifier}` : "Start";
  }

  else if (type === "turn") {
    text = `Turn ${modifier}`;
  }

  else if (type === "continue") {
    text = `Continue ${modifier}`;
  }

  else if (type === "end of road") {
    text = modifier ? `At the end of the road, turn ${modifier}` : "At the end fo the road";
  }

  else {
    text = type.replaceAll("_", " ").replace(/\b\w/g, c => c.toUpperCase());
    
    if (modifier) {
      text += ` ${modifier}`;
    }
  }

  if (road) {
    text += ` onto ${road}`;
  }

  return text || road || "Continue";
}