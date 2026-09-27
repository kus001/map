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

  if (meters >= 1000) {
    return (
      `${(meters / 1000).toFixed(1)} km`
    );
  }

  return (`${Math.round(meters)} m`);
}

export function directionText(step) {
  if (!step) {
    return "Continue";
  }

  const type = step.type || "";
  const instruction = step.instruction || "";
  const modifier = step.modifier || "";
  const road = step.road || step.name || "";

  if (type === "transit" && instruction && modifier && !step.route &&!step.from && !step.to) {
    return `${instruction} ${modifier}`;
  }

  if (instruction) {
    return instruction;
  }

  if (type === "arrive") {
    return ("Arrive at your destination");
  }

  let text;

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
    text = modifier ? (`At the end of the road, turn ${modifier}`) : ("At the end of the road");
  }

  else if (type === "walk") {
    text = "Walk";
    if (step.to) {
      text += ` to ${step.to}`;
    }
  }

  else if (type === "transfer") {
    text = "Transfer";
    if (step.to) {
      text += ` at ${step.to}`;
    }
  }

  else if (type === "transit") {
    if (step.route) {
      text = `Take route ${step.route}`;
    }
    else {
      text = "Take transit";
    }
    if (step.headsign) {
      text += ` toward ${step.headsign}`;
    }
    if (step.from && step.to) {
      text += ` from ${step.from} to ${step.to}`;
    }
  }

  else if (type === "roundabout") {
    text = ("Enter the roundabout");
  }

  else {
    text = type ? type.replaceAll("_", " ").replace(/\b\w/g, char => char.toUpperCase()) : "Continue";
    
    if (modifier) {
      text += (` ${modifier}`);
    }
  }

  if (road && type !== "arrive" && type !== "transit" && type != "walk" && type !== "transfer") {
    text += ` onto ${road}`;
  }

  return text;
}