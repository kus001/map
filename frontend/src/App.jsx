// app.jsx

// import SearchPanel from "./components/SearchPanel";
import { IoMdBicycle } from "react-icons/io";
import { IoCarOutline } from "react-icons/io5";
import { BsPersonWalking } from "react-icons/bs";
import { MdDirectionsTransit } from "react-icons/md";

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

  // next goal is to put all this into SearchPanel.jsx
  return (
    // the width of the left column is set to fixed for now, i want to get the layout and everything right and THEN make it flexible to different screen sizes
    
    // added a temporary border around all this, just so ik the area im working with 
    <div className="w-72 h-screen border-button border-2"> 
      <h1 className="text-3xl font-bold text-center mt-2.5">
        Map Router
      </h1>
      <div className="w-72 grid grid-cols-4 p-4 gap-0.5">
        <button onClick={walking} className="relative flex items-center justify-center gap-4 mx-2.5 hover:shadow-lg hover:bg-button-darker mt-2.5 bg-button p-2 text-white rounded-lg">
          <BsPersonWalking />
        </button>

        <button onClick={cycling} className="relative flex items-center justify-center gap-4 mx-2.5 mt-2.5 hover:shadow-lg hover:bg-button-darker bg-button p-2 text-white rounded-lg">
          <IoMdBicycle />
        </button>

        <button onClick={driving} className="relative flex items-center justify-center gap-4 mx-2.5 mt-2.5 hover:shadow-lg hover:bg-button-darker bg-button p-2 text-white rounded-lg">
          <IoCarOutline />
        </button>

        <button onClick={transit} className="relative flex items-center justify-center gap-4 mx-2.5 mt-2.5 hover:shadow-lg hover:bg-button-darker bg-button p-2 text-white rounded-lg">
          <MdDirectionsTransit />
        </button>
      </div>
    </div>
  );
}

export default App;