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
  if (
    meters === undefined ||
    meters === null ||
    Number.isNaN(meters)
  ) {
    return "";
  }

  if (meters >= 1000) {
    return (
      `${(meters / 1000).toFixed(1)} km`
    )
  }

  return (`${Math.round(meters)} m`);
}

export function directionText(step) {
  if (step.instruction) {
    return step.modifier ? `${step.instruction} ${step.modifier}` : step.instruction
  }

  const type = step.type || "";
  const modifier = step.modifier || "";
  const road = step.road || "";

  if (type === "arrive") {
    return ("Arrive at your destination");
  }

  let text = "";

  if (type === "depart") {
    text = modifier ? `Start heading ${modifier}` : "Start";
  }

  else if (type === "turn") {
    text = modifier ? `Turn ${modifier}` : "Turn";
  }

  else if (type === "continue") {
    text = modifier ? `Continue ${modifier}` : "Continue";
  }
  
  else if (type === "end of road") {
    text = modifier ? (`At the end of the road, ` + `turn ${modifier}`) : ("At the end of the road");
  }

  else if (type === "roundabout") {
    text = ("Enter the roundabout");
  }

  else {
    text = type.replaceAll("_", " ").replace(/\b\w/g, char => char.toUpperCase());
    
    if (modifier) {
      text += (` ${modifier}`);
    }
  }

  if (road) {
    text += (` onto ${road}`);
  }

  return (text || road || "Continue");
}