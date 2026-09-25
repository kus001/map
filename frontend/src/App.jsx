// import SearchPanel from "./components/SearchPanel";

function App() {
  const walking = () => {
    // when pressed, triggers get_walking_route(), shows the routes below the buttons, then updates the map to that route
    console.log("walking pressed")
  }

  const cycling = () => {
    // same as above
    console.log("cycling pressed")
  }

  const driving = () => {
    // same as above
    console.log("driving pressed")
  }

  const transit = () => {
    // same as above
    console.log("transit pressed")
  }

  return (
    // the width of the left column is set to fixed for now, i want to get the layout and everything right and THEN make it flexible to different screen sizes
    <div className="w-72 h-screen">
      <h1 className="text-3xl font-bold text-center mt-2.5">
        Map Router
      </h1>
      <div className="w-72 grid grid-cols-1 p-4 gap-1">
        <button onClick={walking} className="relative mx-2.5 mt-2.5 bg-[#757575] p-2 text-white rounded-lg">
          Walking
        </button>

        <button onClick={cycling} className="relative mx-2.5 mt-2.5 bg-[#757575] p-2 text-white rounded-lg">
          Cycling
        </button>

        <button onClick={driving} className="relative mx-2.5 mt-2.5 bg-[#757575] p-2 text-white rounded-lg">
          Driving
        </button>

        <button onClick={transit} className="relative mx-2.5 mt-2.5 bg-[#757575] p-2 text-white rounded-lg">
          Transit
        </button>
      </div>
    </div>
  );
}

export default App;