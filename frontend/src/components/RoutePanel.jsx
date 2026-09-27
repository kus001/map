import { IoTimeOutline } from "react-icons/io5";
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
    if (type === "transit") {
        return <MdDirectionsTransit />;
    }
    
    return <span className="text-xs">•</span>
}

function TransitMeta({ step }) {
    const pieces = [];
    
    if (step.stops) {
        pieces.push(`${step.stops} ${step.stops === 1 ? "stop" : "stops"}`);
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

    const mode = displayedMode || data.mode || "driving";
    const modeInfo = MODE_INFO[mode] || MODE_INFO.driving;
    const ModeIcon = modeInfo.Icon;
    const activeRoute = selectedRoute || data.routes.find((route) => route.route_number === selectedRouteNumber) || data.routes[0];
    const steps = activeRoute?.steps || [];

    return (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div className="space-y-2">
                {
                    data?.routes?.map((route) => {
                        const selected = route.route_number === activeRoute.route_number;
                        const labels = [];

                        if (data.routes.length > 1 && route.route_number === data.fastest_route_number) {
                            labels.push("FASTEST");
                        }
                        
                        if (data.routes.length > 1 && route.route_number === data.shortest_route_number) {
                            labels.push("SHORTEST");
                        }

                        return (
                            <button
                                type="button"
                                key={route.route_number}
                                onClick={() => onSelectRoute(route.route_number)}
                                className={`w-full rounded-lg border-2 p-4 text-left transition-all ${
                                    selected 
                                        ? "border-green bg-green/10 shadow-sm"
                                        : "border-button-light bg-white hover:border-green hover:shadow-sm"
                                }`}
                            >
                                <div
                                    className="
                                        flex
                                        items-start
                                        justify-between
                                        gap-3
                                    "
                                >
                                    <div>
                                        <div
                                            className="
                                            text-2xl
                                            font-bold
                                            text-charcoal
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
                                                gap-2
                                                text-sm
                                                text-button-darkest
                                            "
                                        >
                                            <ModeIcon />
                                            <span>
                                                {modeInfo.name}
                                            </span>
                                            <span>
                                                •
                                            </span>
                                            <span>
                                                {route.distance_km?.toFixed(2)} km
                                            </span>
                                        </div>
                                        {
                                            mode === "cycling" && (route.ascent_m || route.descent_m) && (
                                                <div
                                                    className="
                                                    mt-1
                                                    text-xs
                                                    text-button-darkest
                                                    "
                                                >
                                                    {route.ascent_m
                                                        ? `↑ ${Math.round(route.ascent_m)} m`
                                                        : ""}
                                                    {route.ascent_m && route.descent_m ? " • " : ""}
                                                    {route.descent_m
                                                        ?  `↓ ${Math.round(route.descent_m)} m`
                                                        : ""}
                                                </div>
                                            )
                                        }
                                    </div>
                                    {labels.length > 0 && (
                                        <div className="
                                            text-right
                                            text-[10px]
                                            font-bold
                                            tracking-wide
                                            text-green-dark"
                                        >
                                            {labels.join(" • ")}
                                        </div>
                                    )}
                                </div>
                            </button>
                        );
                    })
                }
            </div>

            <div className="my-5 border-5 border-button-light" />
            <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-bold text-charcoal">Directions</h2>
                <span className="text-xs text-button-darkest">
                    {steps.length} {steps.length === 1 ? "step" : "steps"}
                </span>
            </div>

            {steps.length === 0 ? (
                <div className="rounded-lg border border-button-light p-4 text-sm text-button-darkest">
                    No directions were returned for this route.
                </div>
            ) : (
                <div className="overflow-hidden rounded-lg border border-button-light bg-white">
                    {steps.map((step, index) => (
                        <div
                            key={`${step.type || "step"}-${index}`}
                            className="flex gap-3 border-b border-button-light p-3 last:border-b-0"
                        >
                            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-charcoal text-white">
                                <StepIcon type={step.type} />
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium leading-5 text-charcoal">
                                    {directionText(step)}
                                </div>
                                {step.type === "transit" ? (
                                    <TransitMeta step={step} />
                                ) : (
                                    <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-button-darkest">
                                        {step.duration_min >= 0.5 && (
                                            <span className="flex items-center gap-1">
                                                <IoTimeOutline />
                                                {formatDuration(step.duration_min)}
                                            </span>
                                        )}
                                        {step.distance_m > 0 && (
                                            <span>{formatDistance(step.distance_m)}</span>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

export default RoutePanel;