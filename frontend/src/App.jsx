// app.jsx

import {useMemo, useState} from "react";
import {MdMyLocation} from "react-icons/md"
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
  const [status, setStatus] = useStatus("Enter a starting point and destination.");
  const [currentLocation, setCurrentLocation] = useState(null);
  const selectedRoute = useMemo(() => route?.routes?.find(route => route.route_number === selectedRouteNumber) || null, [data, selectedRouteNumber]);

  async function searchRoutes(
    requestedMode = mode,
    requestedCyclingType = cyclingType,
    requestedStart = start,
    requestedDestination = destination
  ) {
    const clearnStart = requestedStart.trim();
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
      
      let result;

      try {
        result = await response.json();
      }

      catch {
        throw new Error("The routing server returned an invalid response.");
      }

      if (!response.ok || result.success) {
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

      else if (requestMode === "transit") {
        setStatus("Transit route found");
      }

      else {
        setStatus("Route found");
      }
    }

    catch (routeError) {
      console.error("Route search failed: ", routeError);
      setError(true);
      setStatus(RouteError.message || "Something went wrong.");
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
}










function App() {
  const walking = () => {
    console.log("Walking start: ", start)
    console.log("Walking end: ", end)
  }

  const cycling = () => {
    console.log("Cycling start: ", start)
    console.log("Cycling end: ", end)
  }

  const driving = () => {
    console.log("Driving start: ", start)
    console.log("Driving end: ", end)
  }

  const transit = () => {
    console.log("Transit start: ", start)
    console.log("Transit end: ", end)
  }

  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  // next goal is to put all this into SearchPanel.jsx
  return (
    // the width of the left column is set to fixed for now, i want to get the layout and everything right and THEN make it flexible to different screen sizes
    // added a temporary border around all this, just so ik the area im working with
    <div className="flex h-screen w-screen"> 
      <div className="w-80 h-screen border-charcoal flex flex-col border-2 rounded-r-lg border-charcoal"> 
      {/* title */}
      <h1 onClick={() => window.open("https://github.com/kus001/map", "_blank")} className="text-3xl font-bold hover:font-extrabold text-center mt-2.5" >
        <span className="text-charcoal hover:text-green">Map Router</span>
      </h1>

      {/* starting address */}
      <div className="w-64 mx-auto flex items-center gap-3 mt-5">
        <GoDot />
        <input
          value={start} onChange={(e) => setStart(e.target.value)}
          className="flex items-center justify-center w-full border-2 border-button-light focus:outline-none focus:border-green focus:shadow-md p-2 rounded-lg"
          placeholder="enter starting point..."
        />
      </div>

      {/* ending address */}
      <div className="w-64 mx-auto flex items-center gap-3 mt-2">
        <PiMapPinFill color="#66856B" />
        <input
          value={end} onChange={(e) => setEnd(e.target.value)}
          className="flex items-center justify-center border-2 border-button-light focus:outline-none focus:border-green focus:shadow-md w-full border p-2 rounded-lg"
          placeholder="enter destination..."
        />
      </div>

      {/* buttons */}
      <div className="w-64 grid grid-cols-4 mt-4 mx-auto gap-2">
        <button onClick={walking} className="relative flex items-center justify-center active:bg-green-dark gap-4 hover:shadow-md hover:bg-green mt-2.5 bg-charcoal p-2 text-white rounded-lg">
          <BsPersonWalking />
        </button>

        <button onClick={cycling} className="relative flex items-center justify-center gap-4 mt-2.5 active:bg-green-dark hover:shadow-md hover:bg-green bg-charcoal p-2 text-white rounded-lg">
          <IoMdBicycle />
        </button>

        <button onClick={driving} className="relative flex items-center justify-center gap-4 mt-2.5 active:bg-green-dark hover:shadow-md hover:bg-green bg-charcoal p-2 text-white rounded-lg">
          <IoCarOutline />
        </button>

        <button onClick={transit} className="relative flex items-center justify-center gap-4 mt-2.5 active:bg-green-dark hover:shadow-md hover:bg-green bg-charcoal p-2 text-white rounded-lg">
          <MdDirectionsTransit />
        </button>
      </div>

      {/* directions */}
      <div className="w-64 flex-1 min-h-0 mt-6 mb-4 mx-auto overflow-y-auto border-button border-2 rounded-lg shadow-lg">
        {/* these are js example directions js to see how the routes will look like */}
        <div className="text-center p-1 border-b">
          directions will go here
        </div>
        <div className="text-center p-1 border-b">
          they will be scrollable like this
        </div>
        <div className="text-center p-1 border-b">
          - Kush
        </div>
        <div>
          {Array.from({ length: 30 }, (_, index) => (
            <div
              key={index}
              className="p-3 border-b border-button-light"
            >
              Direction {index + 1}: Continue straight for 200 metres.
            </div>
          ))}
        </div>
      </div>

      <div className="mb-3 flex gap-2 items-center justify-center">
        <span>made by</span> <span onClick={() => window.open("https://github.com/kus001", "_blank")} className="hover:text-green hover:font-bold hover:underline">Kush</span> <span onClick={() => window.open("https://github.com/BigBrain244466666", "_blank")} className="hover:text-green hover:font-bold hover:underline">Victor</span> <span onClick={() => window.open("https://github.com/roc-ket-cod-er", "_blank")} className="hover:text-green hover:font-bold hover:underline">Madhav</span>
      </div>
      </div>
      <div className="flex-1 min-w-0 h-full">
      <MapView />
      </div>
    </div>
  );
}

export default App;