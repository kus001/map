# [Map](https://map-thirdspace.vercel.app/)

Map is a student-made open source routing software. Still under development. 

Feedback welcome, please send to [host-transit-page@user.hackclub.app](mailto:host-transit-page@user.hackclub.app).

## Running the project

The project is now hosted on Vercel with Vite, React, and Tailwind CSS. Access it [here](https://map-thirdspace.vercel.app/).

To run this project locally, fork the repository. Then in the terminal, type `cd frontend` and `npm run dev`. 

![Map Router screenshot](./frontend/public/readme%20pic.png)

### Transit

Transit routing is still under development, but it can be used by running `transit.py`. You set the starting stop and ending stop in the function `transit_a_star(graph, startstop, endstop)`. Only supported agencies are GRT and GO. (Both are south Ontario transit agencies.)

`transit.py` has now been updated to have a full user-interface combined with accurate transfers. The graph now contains appropriate details to route concious of the current date and current time, and find the route that will, in the following order of priority,

1. Arrive the earliest
2. Depart the latest
3. Have the lowest amount of transfers.

### Note

It is recommended to run this project in its own folder so you can easily delete any spawned files. The project generates the transit_data folder when running `transit.py`.
