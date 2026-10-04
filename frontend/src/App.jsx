// app.jsx

import {useMemo, useState} from "react";
import {MdMyLocation} from "react-icons/md";
import { TbMoonStars } from "react-icons/tb";
import { PiSunFill } from "react-icons/pi";
import SearchPanel from "./components/SearchPanel.jsx";
import RoutePanel from "./components/RoutePanel.jsx";
import MapView from "./components/MapView.jsx";

export default function App() {
  const [start, setStart] = useState("");
  const [destination, setDestination] = useState("");
  const [mode, setMode] = useState("driving");
  const [cyclingType, setCyclingType] = useState("regular");
  const [selectedRouteNumber, setSelectedRouteNumber] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [status, setStatus] = useState("Enter a starting point and destination.");
  const [currentLocation, setCurrentLocation] = useState(null);
  const [data, setData] = useState(null);
  const [darkMode, setDarkMode] = useState();
  const selectedRoute = useMemo(() => data?.routes?.find(route => route.route_number === selectedRouteNumber) || null, [data, selectedRouteNumber]);

  async function searchRoutes(
    requestedMode = mode,
    requestedCyclingType = cyclingType,
    requestedStart = start,
    requestedDestination = destination
  ) {
    const cleanStart = requestedStart.trim();
    const cleanDestination = requestedDestination.trim();
    if (!cleanStart || !cleanDestination) {
      setError(true);
      setStatus("Enter both locations.");
      return;
    }
    setLoading(true);
    setError(false);
    setStatus("Finding route...");
    try {
      const response = await fetch("/api/routes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          start: cleanStart,
          destination: cleanDestination,
          mode: requestedMode,
          route_type: requestedCyclingType
        })
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(
          result.error || "Route could not be found."
        );
      }
      
      setData(result);

      setSelectedRouteNumber(result.fastest_route_number || 1);

      if (requestedMode === "driving") {
        const routeCount = result.routes.length;
        setStatus(
          `${routeCount} driving route ${
            routeCount === 1 ? "" : "s"
          } found`
        );
      }

      else if (requestedMode === "walking") {
        setStatus("Walking route found");
      }

      else if (requestedMode === "cycling") {
        const typeName = requestedCyclingType.charAt(0).toUpperCase() + requestedCyclingType.slice(1);
        setStatus(`${typeName} cycling route found`);
      }

      else if (requestedMode === "transit") {
        setStatus("Transit route found");
      }

      else {
        setStatus("Route found");
      }
    }

    catch (routeError) {
      console.error("Route search failed: ", routeError);
      setError(true);
      setStatus(routeError.message || "Something went wrong.");
    }

    finally {
      setLoading(false);
    }
  }
  
  function changeMode(nextMode) {
    setMode(nextMode);
    if (start.trim() && destination.trim()) {
      searchRoutes(nextMode, cyclingType, start, destination);
    }
  }

  function changeCyclingType(nextType) {
    setCyclingType(nextType);
    if (mode === "cycling" && start.trim() && destination.trim()) {
      searchRoutes("cycling", nextType, start, destination);
    }
  }

  function swapLocations() {
    const nextStart = destination;
    const nextDestination = start;

    setStart(nextStart);
    setDestination(nextDestination);

    if (nextStart.trim() && nextDestination.trim()) {
      searchRoutes(mode, cyclingType, nextStart, nextDestination);
    }
  }

  function findLocation() {
    if (!navigator.geolocation) {
      setError(true);
      setStatus("Location is not supported by this browser");
      return;
    }

    setError(false);
    setStatus("Getting your location...");

    navigator.geolocation.getCurrentPosition(
      position => {
        const location = [position.coords.latitude, position.coords.longitude];
        setCurrentLocation(location);
        setStatus("Current location found.");
      },
      locationError => {
        console.error("Location error:", locationError)
        setError(true);
        setStatus("Could not access your location.");
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 30000
      }
    );
  }

  const displayedMode = data?.mode || mode;

  return (
    <div
      className={`
        flex
        h-screen
        w-screen
        overflow-hidden
        bg-white
        ${darkMode ? "bg-green-light" : "bg-green"}
      `}
    >
      <aside
        className={`
          z-[1000]
          flex
          h-screen
          w-[360px]
          flex-shrink-0
          flex-col
          border-r-2
          shadow-xl
          ${darkMode ? "bg-charcoal border-darkmode-gray/30" : "bg-white border-charcoal"}
          max-[760px]:absolute
          max-[760px]:bottom-3
          max-[760px]:left-3
          max-[760px]:right-3
          max-[760px]:h-[58vh]
          max-[760px]:w-auto
          max-[760px]:overflow-hidden
          max-[760px]:rounded-xl
          max-[760px]:border-2
        `}
        >
          <header
            className="
              px-5
              pb-4
              pt-4
            "
          >
            <div className="flex items-center justify-between">
              <a
                href="https://github.com/kus001/map"
                target="_blank"
                rel="noreferrer"
                className={`
                  inline-block
                  text-2xl
                  font-bold
                  tracking-tight
                  transition-all
                  duration-200
                  active:scale-95
                  hover:tracking-wide
                  hover:text-green-dark
                  ${darkMode ? "text-green-light" : "text-green"}
                `}
                >Map Router
              </a>
              <button
                  type="button"
                  onClick={() => setDarkMode(!darkMode)}
              >
                  {darkMode ? (
                      <PiSunFill className="text-green duration-100 hover:scale-92 active:scale-95" />
                  ) : (
                      <TbMoonStars className="text-green duration-100 hover:scale-92 active:scale-96" />
                  )}
              </button>
            </div>
            <div
              className={`
                mt-0.5
                text-[11px]
                text-button
                ${darkMode ? "text-darkmode-gray" : "text-charcoal"}
              `}
            >Drive. Walk. Bike. Transit.
            </div>
          </header>
          <SearchPanel
            start={start}
            destination={destination}
            setStart={setStart}
            setDestination={setDestination}
            mode={mode}
            cyclingType={cyclingType}
            onModeChange={changeMode}
            onCyclingTypeChange = {changeCyclingType}
            onSearch={searchRoutes}
            onSwap={swapLocations}
            loading={loading}
            darkMode={darkMode}
          />
          <RoutePanel
            data={data}
            selectedRoute={selectedRoute}
            selectedRouteNumber={selectedRouteNumber}
            onSelectRoute={setSelectedRouteNumber}
            status={status}
            error={error}
          />
          <footer
            className={`
              flex
              items-center
              justify-center
              gap-2
              border-t
              border-button-light/50
              py-3
              text-[11px]
              text-button
              ${darkMode ? "text-darkmode-gray" : "text-gray"}
            `}
          >
            <span>made by</span>
            <a
              href="https://github.com/kus001"
              target="_blank"
              rel="noreferrer"
              className={`
                transition-all
                duration-100
                ease-out
                hover:tracking-wider
                hover:font-bold
                hover:text-green-light
                hover:underline
                ${darkMode ? "text-darkmode-gray" : "text-gray"}
              `}
            >Kush</a>
            <span>•</span>
            <a
              href="https://github.com/BigBrain244466666"
              target="_blank"
              rel="noreferrer"
              className="
                transition-all
                duration-100
                ease-out
                hover:tracking-wide
                hover:font-bold
                hover:text-green
                hover:underline
              "
            >Victor</a>
            <span>•</span>
            <a
              href="https://github.com/roc-ket-cod-er"
              target="_blank"
              rel="noreferrer"
              className="
                transition-all
                duration-100
                ease-out
                hover:tracking-wide
                hover:font-bold
                hover:text-green
                hover:underline
              "
            >Madhav</a>
          </footer>
        </aside>
        <main
          className="
            relative
            min-w-0
            flex-1
          "
        >
          <MapView
            data={data}
            selectedRouteNumber={selectedRouteNumber}
            selectedMode={displayedMode}
            onSelectRoute={setSelectedRouteNumber}
            currentLocation={currentLocation}
            darkMode={darkMode}
          />
          <button
            type="button"
            onClick={findLocation}
            title="My Location"
            className={`
              absolute
              bottom-[85px]
              right=[10px]
              z-[500]
              
              flex
              size-11
              items-center
              justify-center
              
              rounded-lg
              border-2
              border-charcoal
              
              bg-white
              text-xl
              text-charcoal
              
              shadow-lg
              transition-all
              duration-200
              hover:-transalte-y-1
              hover:border-green
              hover:bg-green
              hover:text-white
              hover:shadow-xl
              
              active:translate-y-0
              
              max-[750px]:bottom-[61vh
            `}
          >
            <MdMyLocation />
          </button>
        </main>
    </div>
  );
}