import { IoMdBicycle } from "react-icons/io";
import { IoCarOutline } from "react-icons/io5";
import { BsPersonWalking } from "react-icons/bs";
import { MdDirectionsTransit } from "react-icons/md";
import { GoDot } from "react-icons/go";
import { PiMapPinFill, PiSunFill } from "react-icons/pi";
import { HiArrowsUpDown } from "react-icons/hi2";

import Button from "./Button.jsx";

const MODES = [
    {
        id:"driving",
        label: "Drive",
        Icon: IoCarOutline
    },
    {
        id: "walking",
        label: "Walk",
        Icon: BsPersonWalking
    },
    {
        id: "cycling",
        label:"Bike",
        Icon: IoMdBicycle
    },
    {
        id: "transit",
        label: "Transit",
        Icon: MdDirectionsTransit
    }
];

const BIKE_TYPES = [
    {
        id: "regular",
        label: "Regular"
    },
    {
        id: "road",
        label: "Road"
    },
    {
        id: "mountain",
        label: "MTB"
    },
    {
        id: "electric",
        label: "E-Bike"
    }
];

export default function SearchPanel({
    start,
    destination,

    setStart,
    setDestination,

    mode,
    cyclingType,
    
    onModeChange,
    onCyclingTypeChange,

    onSearch,
    onSwap,

    loading,
    darkMode
}) {
    function handleEnter(event) {
        if (event.key === "Enter") {
            onSearch();
        }
    }

    return (
        <div className="px-8 pb-6">
            <div className="space-y-4">
                <div className="flex items-center gap-3">
                    <div className="flex w-6 shrink-0 justify-center">
                        <GoDot className={`text-xl ${darkMode ? "text-green-light" : "text-charcoal"}`}/>
                    </div>

                    <input
                        value={start}
                        onChange={event => setStart(event.target.value)}
                        onKeyDown={handleEnter}
                        placeholder="Starting location"
                        darkMode={darkMode}
                        autoComplete="off"
                        className={`
                            h-14
                            min-w-0
                            flex-1
                            rounded-xl
                            border-2
                            border-green-light
                            px-4
                            text-lg
                            ${darkMode ? "text-white" : "text-black"}
                            outline-none
                            transition-all
                            duration-200
                            ease-out
                            focus:border-green
                            focus:ring-2
                            focus:ring-green/15
                        `}
                    />
                </div>

                <div className="flex items-center gap-3">
                    <div className="flex w-6 shrink-0 justify-center">
                        <PiMapPinFill className={`text-xl ${darkMode ? "text-green-light" : "text-green"}`}/>
                    </div>

                    <input
                        value={destination}
                        onChange={event =>
                            setDestination(event.target.value)
                        }
                        onKeyDown={handleEnter}
                        placeholder="Destination"
                        darkMode={darkMode}
                        autoComplete="off"
                        className={`
                            h-14
                            min-w-0
                            flex-1
                            rounded-xl
                            border-2
                            border-green-light
                            px-4
                            text-lg
                            ${darkMode ? "text-white" : "text-black"}
                            outline-none
                            transition-all
                            duration-200
                            ease-out
                            focus:border-green
                            focus:ring-2
                            focus:ring-green/20
                        `}
                    />
                </div>

            </div>
            <div className="mt-3 pl-9">
                <button
                    type="button"
                    disabled={loading}
                    onClick={onSwap}
                    title="Swap locations"
                    className={`
                        flex
                        h-10
                        w-10
                        items-center
                        justify-center
                        rounded-xl
                        text-xl
                        text-white
                        transition
                        hover:bg-green
                        ${darkMode ? "bg-green-light/40" : "bg-green/40"}
                    `}
                >
                    <HiArrowsUpDown />
                </button>
            </div>
            <div
                className="
                    mt-7
                    grid
                    grid-cols-4
                    gap-3
                "
            >
                {MODES.map(({ id, label, Icon }) => (
                    <Button
                        type="button"
                        key={id}
                        active={mode === id}
                        disabled={loading}
                        darkMode={darkMode}
                        onClick={() =>
                            onModeChange(id)
                        }
                        title={label}
                        className="
                            h-12
                            gap-2
                            px-2
                        "
                    >
                        <Icon className="text-lg" />

                        {/* <span className="text-xs">
                            {label}
                        </span> */}
                    </Button>
                ))}
            </div>
            {mode === "cycling" && (
                <div
                    className="
                        soft-enter
                        mt-3
                        grid
                        grid-cols-4
                        gap-2
                    "
                >
                    {BIKE_TYPES.map(option => (
                        <button
                            type="button"
                            key={option.id}
                            disabled={loading}
                            darkMode={darkMode}
                            onClick={() =>
                                onCyclingTypeChange(
                                    option.id
                                )
                            }
                            className={`
                                rounded-lg
                                border
                                px-2
                                py-2
                                text-xs
                                font-semibold
                                transition-all
                                duration-150
                                hover:-translate-y-px
                                ${darkMode ? "bg-green-light" : "bg-green border-green"}
                                ${
                                    cyclingType === option.id
                                        ? `
                                            border-green
                                            bg-green/15
                                            ${darkMode ? "text-white" : "text-green-dark"}
                                        `
                                        : `
                                            border-button-light
                                            ${darkMode ? "bg-charcoal text-white" : "bg-white text-charcoal"}
                                            hover:bg-green/10
                                        `
                                }
                            `}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            )}
            <Button
                type="button"
                disabled={loading}
                onClick={() => onSearch()}
                darkMode={darkMode}
                className={`
                    mt-6
                    h-12
                    w-full
                    shadow-lg
                    ${darkMode ? "bg-green-light" : "bg-green border-green"}
                `}
            >
                {loading
                    ? "Finding route..."
                    : "Find Route"}
            </Button>

        </div>
    );
}