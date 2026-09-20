const map = L.map("map").setView([43.4643, -80.5204], 12);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

let routeLayers = [];
let startMarker = null;
let endMarker = null;
let currentData = null;
let selectedRouteNumber = 1;
let selectedMode = "driving";

const searchButton = document.getElementById("search-button");
const routeOptions = document.getElementById("route-options");
const directions = document.getElementById("directions");
const modeButtons = document.querySelectorAll(".mode-button");
const statusText = document.getElementById("status");
const directionsSection = document.getElementById("directions-section");

modeButtons.forEach(function(button) {
    button.addEventListener("click", function() {
        selectedMode = button.dataset.mode;
        modeButtons.forEach(function(otherButton) {
            otherButton.classList.remove("selected");
        });
        button.classList.add("selected");
        const start = document.getElementById("start").value.trim();
        const destination = document.getElementById("destination").value.trim();
        if (start && destination) {
            searchButton.click();
        }
    });
});

function formatDuration(minutes) {
    const rounded = Math.round(minutes);
    if (rounded < 60) {
        return rounded + " min";
    }
    const hours = Math.floor(rounded / 60);
    const mins = rounded % 60;
    return hours + " hr " + mins + " min";
}

function formatDistance(meters) {
    if (meters >= 1000) {
        return (meters / 1000).toFixed(1) + " km";
    }
    return Math.round(meters) + " m";
}

function directionIcon(step) {
    const modifier = step.modifier || "";
    
    if (step.type === "arrive") {
        return "●";
    }

    if (step.type === "depart") {
        return "↑";
    }

    if (modifier.includes("left")) {
        return "↰";
    }

    if (modifier.includes("right")) {
        return "↱";
    }
    
    return "↑"

    // (from kush) cycling uses a different format than OSRM, so we will have to add another if-statement that checks for step.instruction()
}

function formatDirection(step) {
    const type = step.type;
    const modifier = step.modifier;
    const road = step.road;

    // convert openroutservice into OSRM format
    if (step.instruction && !type) {
        return step.instruction
    }

    let text = "";

    if (type === "depart") {
        text = "Start";
        if (modifier) {
            text += " heading " + modifier;
        }
    }

    else if (type === "arrive") {
        text = "Arrive at your destination";
    }

    else if (type === "turn") {
        text = "Turn";
        if (modifier) {
            text += " " + modifier;
        }
    }

    else if (type === "continue") {
        text = "Continue";
        if (modifier) {
            text += " " + modifier;
        }
    }

    else if (type === "end of road") {
        text = "At the end of the road";
        if (modifier) {
            text += ", turn " + modifier;
        }
    }

    else {
        text = type.replaceAll("_", " ").replace(/\b\w/g, function(letter) {
            return letter.toUpperCase();
        });

        if (modifier) {
            text += " " + modifier;
        }
    }

    if (road && type !== "arrive") {
        text += " onto " + road;
    }

    return text;
}

function renderDirections(route) {
    directions.innerHTML = "";

    route.steps.forEach(function(step) {
        const item = document.createElement("div");

        item.className = "direction-step";
        item.innerHTML = `
            <div class="direction-icon">
                ${directionIcon(step)}
            </div>
            <div class="direction-text">
                ${formatDirection(step)}
            </div>
            <div class="direction-distance">
                ${formatDistance(step.distance_m)}
            </div>
        `;

        directions.appendChild(item);
        directionsSection.style.display = "block";
    });
}

function renderRouteCards() {
    routeOptions.innerHTML = "";

    currentData.routes.forEach(function(route) {
        const card = document.createElement("div");
        card.className = "route-card";

        if (route.route_number === selectedRouteNumber) {
            card.classList.add("selected");
        }

        let labels = [];

        if (currentData.routes.length > 1) {
            if (route.route_number === currentData.fastest_route_number) {
                labels.push("FASTEST");
            }

            if (route.route_number === currentData.shortest_route_number) {
                labels.push("SHORTEST");
            }
        }
        
        const routeName = selectedMode === "walking" ? "Walking route" : "Route " + route.route_number;

        card.innerHTML = `
            <div class="route-time">
                ${formatDuration(route.duration_min)}
            </div>
            <div class="route-info">
                ${routeName} • ${route.distance_km.toFixed(2)} km
            </div>
            <div class="route-label">
                ${labels.join(" • ")}
            </div>
        `;

        card.addEventListener("click", function() {
            selectRoute(route.route_number);
        });

        routeOptions.appendChild(card);
    });
}

function selectRoute(routeNumber) {
    selectedRouteNumber = routeNumber;
    const selectedRoute = drawRoutes();

    renderRouteCards();
    renderDirections(selectedRoute);
}

function drawRoutes() {
    routeLayers.forEach(function(layer) {
        map.removeLayer(layer);
    });

    routeLayers = [];

    currentData.routes.forEach(function(route) {
        if (route.route_number !== selectedRouteNumber) {
            const line = L.polyline(route.route_coordinates, {
                color: "#777",
                weight: 4,
                opacity: 0.4
            }).addTo(map);

            line.on("click", function() {
                selectRoute(route.route_number);
            });

            routeLayers.push(line);
        }
    });

    const selectedRoute = currentData.routes.find(function(route) {
        return route.route_number === selectedRouteNumber;
    });

    const selectedLine = L.polyline(selectedRoute.route_coordinates, {
        color: "#2563eb",
        weight: 7,
        opacity: 0.9,
        dashArray: selectedMode === "walking" ? "1 9" : null,
        lineCap: "round"
    }).addTo(map);
    routeLayers.push(selectedLine);
    return selectedRoute;
}

async function searchRoutes() {
    const start = document.getElementById("start").value.trim();
    const destination = document.getElementById("destination").value.trim();
    
    if (!start || !destination) {
        statusText.textContent = "Enter both locations.";
        return;
    }

    searchButton.disabled = true;

    searchButton.textContent = "finding routes...";

    if (selectedMode === "walking") {
        statusText.textContent = "finding walking route...";
    }

    else {
        statusText.textContent = "Finding driving routes...";
    }
    
    try {
        const response = await fetch("/api/routes", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                start: start,
                destination: destination,
                mode: selectedMode
            })
        });

        const data = await response.json();

        if (!data.success) {
            alert(data.error);
            return;
        }

        if (startMarker !== null) {
            map.removeLayer(startMarker);
        }

        if (endMarker !== null) {
            map.removeLayer(endMarker);
        }

        currentData = data;

        selectedRouteNumber = data.fastest_route_number;

        const selectedRoute = drawRoutes();

        renderRouteCards();

        renderDirections(selectedRoute);

        startMarker = L.marker(data.start.coordinates).addTo(map);
        startMarker.bindPopup("Start: " + data.start.address);
        endMarker = L.marker(data.end.coordinates).addTo(map);
        endMarker.bindPopup("Destination: " + data.end.address);

        map.fitBounds(selectedRoute.route_coordinates);

        if (selectedMode === "walking") {
            statusText.textContent = "walking route";
        } 
        else if (selectedMode === "cycling") { // added by KUS
            statusText.textContent = "cycling route";
        } 
        else {
            statusText.textContent = data.routes.length + " driving route" + (data.routes.length === 1 ? "" : "s");
        }
    }

    catch (error) {
        console.error(error);
        statusText.textContent = "Something went wrong while finding the route.";
    }

    finally {
        searchButton.disabled = false;
        searchButton.textContent = "Find routes";
    }
}

searchButton.addEventListener(
    "click",
    searchRoutes
);

document.getElementById("start").addEventListener("keydown", function(event) {
    if (event.key === "Enter") {
        searchRoutes();
    }
});

document.getElementById("destination").addEventListener("keydown", function(event) {
    if (event.key === "Enter") {
        searchRoutes();
    }
});