import { IoMdBicycle } from "react-icons/io";
import { IoCarOutline } from "react-icons/io5";
import { BsPersonWalking } from "react-icons/bs";
// import { MdDirectionsTransit } from "react-icons/md"; (not sure if transit is ready yet)

const Modes = [
    {
        id:"driving",
        label: "Drive",
        icon: IoCarOutline
    },
    {
        id: "walking",
        label: "Walk",
        icon: BsPersonWalking
    },
    {
        id: "cycling",
        label:"Bike",
        icon: IoMdBicycle
    }
    // this is for the future, not sure if transit is ready yet

    // {
    //     id: "transit",
    //     label: "Transit",
    //     icon: MdDirectionsTransit
    // }
];