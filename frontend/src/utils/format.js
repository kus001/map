            

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
    text = modifier === "straight" ? "Continue straight" : modifier ? `Turn ${modifier}` : "Turn";
  } else if (type === "new name") {
                                                                   
    text = "Continue";
  } else if (type === "fork") {
    text = modifier ? `Keep ${modifier.replace("slight ", "")}` : "Keep going";
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

    if (step.display_headsign || step.headsign) {
      text += ` toward ${step.display_headsign || step.headsign}`;
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

// How late a live transit leg is right now. Returns null when there is no live data for it.
// tone: "late" | "early" | "ontime" | "cancelled"
export function liveDelayInfo(step) {
  if (!step || step.type === "walking") {
    return null;
  }

  if (step.cancelled) {
    return { label: "Cancelled", tone: "cancelled", minutes: 0 };
  }

  if (!step.realtime) {
    return null;
  }

  const minutes = Math.round(Number(step.delay_min) || 0);
  if (minutes >= 1) {
    return { label: `${minutes} min late`, tone: "late", minutes };
  }
  if (minutes <= -1) {
    return { label: `${-minutes} min early`, tone: "early", minutes };
  }
  return { label: "On time", tone: "ontime", minutes: 0 };
}

// One line for the whole route: the leg that is the most behind (or cancelled).
export function routeLateness(steps) {
  const live = (steps || [])
    .filter(step => step?.type === "transit")
    .map(liveDelayInfo)
    .filter(Boolean);

  if (!live.length) {
    return null;
  }

  return (
    live.find(info => info.tone === "cancelled") ||
    live.reduce((worst, info) => (info.minutes > worst.minutes ? info : worst))
  );
}

const POWERTRAIN_LABELS = { normal: "Normal", hev: "Hybrid (HEV)", electric: "Electric" };

// Bus details the backend attaches to live GRT vehicles (vehicle.info). Returns null when unknown.
export function vehicleSpecs(vehicle) {
  const info = vehicle?.info;
  if (!info || (!info.year && !info.powertrain)) {
    return null;
  }

  const model = String(info["vehicle type"] || "").trim();
  const seats = Number(info.seats);
  return {
    year: info.year || null,
    model: model || null,
    powertrain: info.powertrain || null,
    powertrainLabel: POWERTRAIN_LABELS[info.powertrain] || null,
    seats: Number.isFinite(seats) && seats > 0 ? seats : null,
  };
}
