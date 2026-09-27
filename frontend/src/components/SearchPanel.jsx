import { IoMdBicycle } from "react-icons/io";
import { IoCarOutline } from "react-icons/io5";
import { BsPersonWalking } from "react-icons/bs";
import { MdDirectionsTransit } from "react-icons/md";
import {GoDot} from "react-icons/go";
import {PiMapPinFill} from "react-icons/pi";
import {HiArrowsUpDown} from "react-icons/hi2";

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

    loading
}) {
    function handleEnter(event) {
        if (event.key === "Enter") {
            onSearch();
        }
    }

    return (
        <div
            className="
                border-b
                border-button-light/40
                px-5
                pb-5
            "
        >
            <div
                className="
                    flex
                    w-5
                    flex-col
                    items-center
                    py-3
                "
            >
                <GoDot
                    className="
                    text-lg
                    text-charcol
                    "
                />

                <div
                    className="
                        my-1
                        w-px
                        flex-1
                        bg-button-light
                    "
                />

                <PiMapPinFill
                    className="text-green"
                />
            </div>

            <div
                className="
                    flex
                    flex-1
                    flex-col
                    gap-2
                "
            >
                <input
                    value={start}
                    onChange={event => setStart(event.target.value)}
                    onKeyDown={handleEnter}
                    placeholder="Starting location"
                    autoComplete="off"
                    className="
                        h-11
                        rounded-lg
                        border-2
                        border-button-light
                        bg0white
                        px-3
                        text-sm
                        text-charcoal
                        outline-none
                        transition-all
                        duration-200

                        placeholder:
                        text-button

                        focus:
                        border-green

                        focus:
                        shadow-md
                    "
                />

                <input
                    value={destination}
                    onChange={event => setDestination(event.target.value)}
                    onKeyDown={handleEnter}
                    placeholder="Destination"
                    autoComplete="off"
                    className="
                        h-11
                        rounded-lg
                        border-2
                        border-button-light
                        bg-white
                        px-3
                        text-sm
                        text-charcoal
                        outline-none
                        transition-all
                        duration-200
                        
                        placeholder:
                        text-button
                        
                        focus:
                        border-green
                        
                        focus: shadow-md
                    "
                />

                <button
                    type="button"
                    disabled={loading}
                    onClick={onSwap}
                    title={"Swap locations"}
                    className="
                        my-auto
                        flex
                        size-9
                        items-center
                        justify-center
                        rounded-lg
                        bg-charcoal
                        text-white
                        transition-all
                        duration-200
                        
                        hover:
                        rotate-180

                        hover:
                        bg-green

                        disabled:
                        opacity-50
                    "
                >
                    <HiArrowsUpDown />
                </button>
            </div>

            <div
                className="
                    mt-4
                    grid
                    grid-cols-4
                    gap-2
                "
            >
                {
                    MODES.map(
                        ({id, label, Icon}) => (
                            <Button
                                type="button"
                                key={id}
                                active={mode === id}
                                disabled={loading}
                                onClick={() => onModeChange(id)}
                                title={label}
                                className="
                                    h-10
                                    gap-1
                                    px-1
                                "
                            >
                                <Icon className="text-lg"/>
                                <span className="text-[10px]">
                                    {label}
                                </span>
                            </Button>
                        )
                    )
                }
            </div>
            
            {
                mode ==="cycling" && (
                <div
                    className="
                        soft-enter
                        mt-3
                        grid
                        grid-cols-4
                        gap-1.5
                    "
                >
                    {
                        BIKE_TYPES.map(
                            option => (
                                <button
                                    type="button"
                                    key="options.id"
                                    disabled={loading}
                                    onClick={() => onCyclingTypeChange(option.id)}
                                    className={`
                                        rounded-lg
                                        border
                                        px-1
                                        py-2
                                        text-[10px]
                                        font-semibold
                                        transition-all
                                        duration-150
                                        
                                        hover:
                                        -translate-y-px
                                        
                                        ${
                                            cyclingType === option.id ? `
                                                border-green
                                                bg-green/15
                                                text-green-dark
                                                `
                                                : `
                                                    border-button-light
                                                    bg-white
                                                    text-charcoal
                                                    
                                                    hover:
                                                    bg-green/10
                                                    `
                                        }
                                    `}
                                >
                                    {option.label}
                                </button>
                            )
                        )
                    }
                </div>
                )
            }

            <Button
                type="button"
                disabled={loading}
                onClick={() => onSearch()}
                className="
                    mt-3
                    h-11
                    w-full
                    text-sm
                "
            >
                {loading ? "Finding route..." : "Find Route"}
            </Button>
        </div>
    );
}