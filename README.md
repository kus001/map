# [Map](https://map-thirdspace.vercel.app/)

Map is a student-made open source routing software. Still under development. 

Feedback welcome, please send to [host-transit-page@user.hackclub.app](mailto:host-transit-page@user.hackclub.app).

## Running the project

The project is now hosted on Vercel with Vite, React, and Tailwind CSS. Access it [here](https://map-thirdspace.vercel.app/).

To run the project, as of now, you should run main.py. This will host the transit webpage locally, and then you should open [http://127.0.0.1:5000](http://127.0.0.1:5000). However, as of now, that will only open the driving/walking router, as transit is not yet finished.

![Map Router interface with a calm, functional appearance. The left panel shows the title Map Router, fields labeled Starting location and Destination, a Find routes button, Drive and Walk options, and the message Enter a starting point and destination. The right side displays an OpenStreetMap view of Waterloo, Kitchener, and surrounding rural areas, with zoom controls and labels including University of Waterloo, Waterloo, Kitchener, St. Jacobs, and regional roads.](assets/image.png)

### Cycling

Cycling is still under development, and will be added soon.

### Transit

Transit routing is still under development, but it can be used by running `transit.py`. You set the starting stop and ending stop in the function `transit_a_star(graph, startstop, endstop)`. Only supported agencies are GRT and GO. (Both are south Ontario transit agencies.)

Please note, that although it can be run, `transit.py` will find the fastest route assuming that all routes are always running 24/7 with 3 min headways. Of course, that's not the fact. It is unable to find the best route for right now, but it still constructs the graph and is able to search through it.

Furthermore, it doesn't have a stop search as of now, which means that you have to input in stop ids. You can use the current example ones, or you can open Google Maps and search for GRT/GO Stop IDs. Fun ones could be `go:UN`, `grt_trains:6001` or others. You can find full lists of stops once the project runs and downloads the files. The full stop list will be availible in `transit_data/GTFS_Files/agency/stops.txt`

Please note that `transit.py` still outputs some debug information to help see the full route.

### Note

It is recommended to run this project in its own folder so you can easily delete any spawned files. The project generates the transit_data folder when running `transit.py`.
