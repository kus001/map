// app.jsx

// import SearchPanel from "./components/SearchPanel";
import { IoMdBicycle } from "react-icons/io";
import { IoCarOutline } from "react-icons/io5";
import { BsPersonWalking } from "react-icons/bs";
import { MdDirectionsTransit } from "react-icons/md";
import { GoDot } from "react-icons/go";
import { PiMapPinFill } from "react-icons/pi";
import { useState } from "react";
import MapView from "./components/MapView";

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