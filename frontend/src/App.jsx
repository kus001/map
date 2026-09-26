// app.jsx

// import SearchPanel from "./components/SearchPanel";
import { IoMdBicycle } from "react-icons/io";
import { IoCarOutline } from "react-icons/io5";
import { BsPersonWalking } from "react-icons/bs";
import { MdDirectionsTransit } from "react-icons/md";

function App() {
  const walking = () => {
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
    <div className="w-72 h-screen border-button border-2 rounded-r-lg"> 
      {/* title */}
      <h1 className="text-3xl font-bold text-center mt-2.5">
        Map Router
      </h1>

      {/* starting address */}
      <div className="w-60 mx-auto mt-5">
        <input
          className="flex items-center justify-center w-full border-2 border-button-light focus:outline-none focus:border-button focus:shadow-md p-2 rounded-lg"
          placeholder="enter starting point..."
        />
      </div>

      {/* ending address */}
      <div className="w-60 mx-auto mt-2">
        <input
          className="flex items-center justify-center border-2 border-button-light focus:outline-none focus:border-button focus:shadow-md w-full border p-2 rounded-lg"
          placeholder="enter destination..."
        />
      </div>

      {/* buttons */}
      <div className="w-60 grid grid-cols-4 mt-4 mx-auto gap-2">
        <button onClick={walking} className="relative flex items-center justify-center active:bg-button-darkest gap-4 hover:shadow-lg hover:bg-button-darker mt-2.5 bg-button p-2 text-white rounded-lg">
          <BsPersonWalking />
        </button>

        <button onClick={cycling} className="relative flex items-center justify-center gap-4 mt-2.5 active:bg-button-darkest hover:shadow-lg hover:bg-button-darker bg-button p-2 text-white rounded-lg">
          <IoMdBicycle />
        </button>

        <button onClick={driving} className="relative flex items-center justify-center gap-4 mt-2.5 active:bg-button-darkest hover:shadow-lg hover:bg-button-darker bg-button p-2 text-white rounded-lg">
          <IoCarOutline />
        </button>

        <button onClick={transit} className="relative flex items-center justify-center gap-4 mt-2.5 active:bg-button-darkest hover:shadow-lg hover:bg-button-darker bg-button p-2 text-white rounded-lg">
          <MdDirectionsTransit />
        </button>
      </div>

      {/* directions */}
      <div className="w-60 grid-cols-1 mt-6 mx-auto overflow-y-auto h-95 border-button border-2 rounded-lg shadow-lg">
        {/* these are js example directions js to see how the routes will look like */}
        <div className="text-center p-1 border-b">
          scrollable directions here
        </div>
        <div className="text-center p-1 border-b">
          turn left
        </div>
        <div className="text-center p-1 border-b">
          go straight
        </div>
      </div>
    </div>
  );
}

export default App;