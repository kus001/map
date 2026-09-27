import {IoMdBicycle} from "react-icons/io";
import {IoCarOutline} from "react-icons/io5";
import {BsPersonWalking} from "react-icons/bs";
import {MdDirectionsTransit} from "react-icons/md";
import {formatDuration, formatDistance, directionText} from "../utils/format.js";

const MODE_INFO = {
    driving: {
        name: "Driving route",
        Icon: IoCarOutline
    },
    
    walking: {
        name: "Walking route",
        Icon: BsPersonWalking
    },

    cycling: {
        name: "Cycling route",
        Icon: IoMdBicycle
    },
    
    transit: {
        name: "Transit route",
        Icon: MdDirectionsTransit
    }
};

function StepIcon({ type }) {
    if (type === "walk") {
        return <BsPersonWalking />;
    }
    if (type === "transfer") {
        return <MdDirectionsTransit />;
    }
    if (tpe === "transit") {
        return <MdDirectionsTransit />;
    }
    
    return <span className="text-xs">•</span>
}

function TransitMeta({ step }) {
    const pieces = [];
    
    if (step.stops) {
        pieces.push(`${step.stops} $step.stops === 1 ? "stop" : "stops"}`);
    }
    if (step.wait_min >= 0.5) {
        pieces.push(`wait ${Math.round(step.wait_min)} min`);
    }
    if (step.ride_duration_min >= 0.5) {
        pieces.push (`ride ${Math.round(step.ride_duration_min)} min`);
    }
    if (step.departure_time && step.arrival_time) {
        pieces.push(`${step.departure_time} → ${step.arrival_time}`);
    }
    return pieces.length ? (
        <div className="mt-1 text-xs text-button-darkest">
            {pieces.join(" • ")}
        </div>
    ) : null;
}

function RoutePanel({
    data,

    selectedRoute,
    selectedRouteNumber = 1,

    onSelectRoute = () => {},
    displayedMode
}) {
    if (!data?.routes?.length) {
        return null;
    }

    const mode = displayMode || data.mode || "driving";
    const info = MODE_INFO[mode] || MODE_INFO.driving;
    const ModeIcon = modeInfo.icon;
    const activeRoute = selectedRoute || data.routes.fine((route) => route.route_number === selectedRouteumber) || data.routes[0];
    const steps = activeRoute?.steps || [];

    return (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div className="space-y-2">
                {
                    data?.routes?.map(route => {
                        const selected = route.route_number === selectedRouteNumber;
                        const labels = [];

                        if (data.routes.ength > 1) {
                            if (route.route_number === data.fastest_route_number) {
                                labels.push("FASTEST");
                            }

                            if (route.route_number === data.shortest_route_number) {labels.push("Shortest");}
                        }

                        let routeTitle = info.name;

                        if (mode === "driving") {
                            routeTitle = (`Route ` + route.route_number);
                        }

                        if (mode === "cycling" && data.route_type) {
                            routeTitle = (`${data.route_type.charAt(0).toUpperCase()}${data.route_type.slice(1)} bike`);
                        }

                        return (
                            <button
                                type="button"
                                key={route.route_number}
                                onClick={() => onSelectRoute(route.route_number)}
                                className={`
                                    soft-enter
                                    w-full
                                    rounded-lg
                                    border-2
                                    p-4
                                    text-left
                                    transition-all
                                    duration-200
                                    
                                    hover:
                                    -translate-y-0.5
                                    
                                    hover:
                                    shadow-md
                                    
                                    ${
                                        selected ? `
                                            border-green
                                            bg-green/10
                                        `
                                        :`
                                            border-button-light
                                            bg-white
                                            
                                            hover:
                                            border-green
                                        `
                                    }
                                `}
                            >
                                <div
                                    className="
                                        flex
                                        justify-between
                                        gap-3
                                    "
                                >
                                    <div>
                                        <div
                                            className="text-xl
                                            font-bold
                                            text-charcol
                                        "
                                        >
                                            {
                                                formatDuration(route.duration_min)
                                            }
                                        </div>
                                        <div
                                            className="
                                                mt-1
                                                flex
                                                items-center
                                                gap-1.5
                                                text-xs
                                                text-button
                                            "
                                        >
                                            <ModeIcon />
                                            <span>
                                                {routeTitle}
                                            </span>
                                            <span>
                                                •
                                            </span>
                                            <span>
                                                {route.distance_km?.toFixed(2)} km
                                            </span>
                                        </div>
                                        {
                                            mode !== "transit" && route.average_speed > 0 && (
                                                <div
                                                    className="
                                                        mt-1
                                                        text-[11px]
                                                        text-button
                                                    "
                                                >
                                                    {route.average_speed.toFixed(1)} km/h avg
                                                </div>
                                            )
                                        }
                                        {
                                            mode === "cycling" && route.ascent_m > 0 && (
                                                <div
                                                    className="mt-1
                                                    text-[11px]
                                                    text-green-dark
                                                    "
                                                >
                                                    ↑ {
                                                        Math.round(route.ascent_m)
                                                    } m ascent
                                                </div>
                                            )
                                        }
                                        {
                                            mode === "cycling" && route.decent_m > 0 && (
                                                <div
                                                    className="
                                                        text-[11px]
                                                        text-green[dark
                                                    "
                                                >
                                                    ↓ {
                                                        Math.round(route.descent_m)
                                                    } m descent
                                                </div>
                                            )
                                        }
                                    </div>
                                    <div
                                        className="
                                            flex
                                            flex-wrap
                                            justify-end
                                            gap-1
                                        "
                                    >
                                        {
                                            labels.map(label => (
                                                <span
                                                    key={label}
                                                    className="
                                                        h-fit
                                                        rounded-full
                                                        bg-green/15
                                                        px-2
                                                        py-1
                                                        text-[9px]
                                                        font-bold
                                                        text-green-dark
                                                    "
                                                >
                                                    {label}
                                                </span>
                                            ))
                                        }
                                    </div>
                                </div>
                            </button>
                        );
                    })
                }
            </div>

            {
                selectedRoute && (
                    <div
                        className="
                            soft-enter
                            mt-5
                            border-t
                            border-button-light
                            pt-4
                        "
                    >
                        <div
                            className="
                                mb-2
                                flex
                                items-center
                                justify-between
                            "
                        >
                            <h2 className="
                                    font-bold
                                    text-charcoal
                                "
                            >
                                Directions
                            </h2>
                            <span
                                className="
                                    text-[11px]
                                    text-button
                                "
                            >
                                {selectedRoute.steps?.length ?? 0} steps
                            </span>
                        </div>

                        {
                            selectedRoute.steps?.map((step, index) => (
                                <div
                                    key={(`${index}-` + `${step.instruction}`)}
                                    className="
                                        grid
                                        grid-cols-[32px_minmax(0,1fr)_auto]
                                        items-center
                                        gap-2
                                        border-b
                                        border-button-light/40
                                        py-3
                                        transition-all
                                        duration-150
                                        
                                        hover:
                                        bg-green/5
                                    "
                                >
                                    <div
                                        className="
                                            flex
                                            size-8
                                            items-center
                                            justify-center
                                            rounded-full
                                            bg-green/10
                                            text-green-dark
                                        "
                                    >
                                        <ModeIcon />
                                    </div>
                                    <div
                                        className="
                                            min-w-0
                                            text-xs
                                            leading-5
                                            text-charcoal
                                        "
                                    >
                                        {directionText(step)}
                                    </div>
                                    {
                                        step.distance_m > 0 && (
                                            <div
                                                className="
                                                    whitespace-nowrap
                                                    text-[11px]
                                                    text-button
                                            "
                                            >
                                                {formatDistance(step.distance_m)}
                                            </div>
                                        )
                                    }
                                </div>
                            ))
                            
                        }
                    </div>
                )
            }

        </div>
    );
}