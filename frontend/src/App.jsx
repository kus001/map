function App() {
  const walking = () => {
    console.log("walking pressed")
  }

  const cycling = () => {
    console.log("cycling pressed")
  }

  const driving = () => {
    console.log("driving pressed")
  }

  const transit = () => {
    console.log("transit pressed")
  }

  return (
    <div className="w-screen h-screen">
      <h1 className="text-3xl font-bold">
        Map Router
      </h1>

      <button onClick={walking} className="relative mx-2.5 mt-2.5 bg-blue-500 p-2 text-white rounded-full">
        Walking
      </button>

      <button onClick={cycling} className="relative mx-5 mt-2.5 bg-green-500 p-2 text-white rounded-lg">
        Cycling
      </button>

      <button onClick={driving} className="relative mx-2.5 mt-2.5 bg-orange-500 p-2 text-white rounded-2xl">
        Driving
      </button>

      <button onClick={transit} className="relative mx-2.5 mt-2.5 bg-purple-500 p-2 text-white rounded-md">
        Transit
      </button>
    </div>
  );
}

export default App;