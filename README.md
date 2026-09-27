# <center> [Map](https://map-thirdspace.vercel.app/)

#### [Map](https://map-thirdspace.vercel.app/) is a student-made open source routing software. [Map](https://map-thirdspace.vercel.app/) is still under development, and all feedback is always welcome, please send to [host-transit-page@user.hackclub.app](mailto:host-transit-page@user.hackclub.app).

## <center> Running / Using [Map](https://map-thirdspace.vercel.app/)

#### <center> [Map](https://map-thirdspace.vercel.app/) is now hosted on Vercel at [this](https://map-thirdspace.vercel.app/) URL! Additionally, you can click any instance of the word '[Map](https://map-thirdspace.vercel.app/)' to go to the webpage!

If you'd rather compile it and run it yourself, locally, that to is simple. You must have Vite and `npm`.\
To run [Map](https://map-thirdspace.vercel.app/) locally, follow the following (quite simple) steps!

1. Fork [the Map repository](https://github.com/kus001/map). **Please note that forking is *optional*** Forking the repository creates your own version of the files, allowing you to modify and edit the open source files however you so desire!

2. Next, clone the repository. Cloning the newly made repository permits you to have your own version of [our repository](https://github.com/kus001/map) downloaded locally onto your computer!
If you forked the repository first, run `git clone <your-repository-url>`.
If you did *not* fork [our repository](https://github.com/kus001/map),
all you have to do is run `git clone https://github.com/kus001/map`

3. Then in the terminal, type `cd frontend` and `npm run dev`. You will need API keys in the .env

![Map Router screenshot](./frontend/public/readme%20pic.png)

### Transit

Transit routing is still under development, but it can be used by running `transit.py`. You set the starting stop and ending stop in the function `transit_a_star(graph, startstop, endstop)`. Only supported agencies are GRT and GO. (Both are south Ontario transit agencies.)

`transit.py` has now been updated to have a full user-interface combined with accurate transfers. The graph now contains appropriate details to route concious of the current date and current time, and find the route that will, in the following order of priority,

1. Arrive the earliest
2. Depart the latest
3. Have the lowest amount of transfers.

### Note

It is recommended to run this project in its own folder so you can easily delete any spawned files. The project generates the transit_data folder when running `transit.py`.
