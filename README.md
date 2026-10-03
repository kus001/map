# <center> [Map](https://map.host-transit-page.hackclub.app/)

#### [Map](https://map.host-transit-page.hackclub.app/) is a student-made open source routing software, and it's still under development, and all feedback is always welcome, please send to [host-transit-page@user.hackclub.app](mailto:host-transit-page@user.hackclub.app).

## <center> Running / Using [Map](https://map.host-transit-page.hackclub.app/)

<center><strong> <a href=https://map.host-transit-page.hackclub.app> Map </a> is now hosted at <a href=https://map.host-transit-page.hackclub.app/)>this URL! </a> Additionally, you can click many instances of the word '<a href=https://map.host-transit-page.hackclub.app>Map</a>' to go to the webpage! </strong></center>

If you'd rather compile it and run it yourself, locally, that to is simple. You must have Vite and `npm`.\
In fact, Map is designed to be able to run fully offline for transit routing! the local A* will work its way and route. However, if the address is not in the Region Of Waterloo's Address Lookup, then you will require either putting in the location into `transit_data/geocode_cache.json`.

To run [Map](https://map.host-transit-page.hackclub.app/) locally, follow the following (quite simple) steps!

1. Fork [the Map repository](https://github.com/kus001/map). **Please note that forking is *optional*** Forking the repository creates your own version of the files, allowing you to modify and edit the open source files however you so desire!

2. Next, clone the repository. Cloning the newly made repository permits you to have your own version of [our repository](https://github.com/kus001/map) downloaded locally onto your computer! Please note that where you are type the following in will be where the new folder is made.

   - If you forked the repository first, run `git clone <your-repository-url>`.
   - If you did *not* fork [our repository](https://github.com/kus001/map),
all you have to do is run `git clone https://github.com/kus001/map`

3. If you haven't changed directories after running the previous command, **skip this step**. Otherwise, you must change your [working directory](https://en.wikipedia.org/wiki/Working_directory) to the one in which you cloned/downloaded the files. This is the one that we can't really help you with, but it will be wherever you ran the previous command. 

    - For example on windows if you ran this in `C:\Users\YourName\Documents\Github`, then you want to run `cd C:\Users\YourName\Documents\Github`

4. Next, once you are into your local version of your repo, run `cd frontend`

5. Install dependancies by running `npm install`

6. Finally, run the project via `npm run dev`. You can run `npm run dev -- --host` to make it discoverable to other computers on the network!

7. Install more dependancies by running `pip install -r requirements.txt` in the base folder (typically `map/`) (in a new terminal)

8. Make sure to run `python3 main.py` or else your server will not function! The server uses ports 8080 and 5173.

9. That's it! If you'd like to host your own server, keep reading.

    1. Build: build the website by running `npm run build` in the `frontend` directory.

    2. Install PM2: `npm install pm2@latest -g`
    
    3. Still in the `frontend` directory, run `pm2 start ecosystem.config.cjs --env production`

    4. To keep the python script running in the background, run `nohup python3 main.py > output.log 2>&1 &` in the base directory where `main.py` resides.

![Map Router screenshot](./frontend/public/readme%20pic.png)

### <center> TRANSIT

The transit router residing in `transit.py` has now been updated to have a full user-interface combined with accurate transfers! The router uses a homegrown version of the [A*](https://en.wikipedia.org/wiki/A*_search_algorithm) (Pronounced A Star) search algorithm! The graph now contains appropriate details to route concious of the current date and current time, and find the route that will, in the following order of priority,

1. Arrive the earliest
2. Depart the latest
3. Have the least amount of transfers.

However, the transit system *does not* provide walking instructions to the and in between stops. That should be added at some point soon.

Here's a sample output!

![Sample Transit Output](./frontend/public/transit_sample_output.png)

## <center> NOTES </center>

<details>
<summary><h3 style="display: inline;"> Running transit.py </h3></summary>

It is recommended to run this project in its own folder so you can easily delete any spawned files. The project generates the transit_data folder when running `transit.py`.

</details>

<details>
<summary><h3 style="display: inline;">Speed Limitation on transit.py</h3></summary>

~~Additionally, since the transit router is written in Python and uses a relatively brute-forced approach, long distance commuting can be very, very slow to calculate. Althought the base A* algorithm is quite fast, there is an additional step on top of it slowing it down quite a bit, the step being searching 900 times, from the 30 closest stops to you and the 30 closest stops to the destination. A speed update will be coming soon, as currently the system uses just brute force, but the A* algorithm's graph could likely be updated to include the additional edges with the 30 closest stops being attached to the starting stop, allowing the A* algorithm to not have to search the same stop so many times (And not have to be run 900 times!)~~

FIXED!! Algorithm now runs really quickly, and only once! However, for long distances it can still be quite slow ... even then that's most likely just a server side problem, very usable as an end user.

</details>

<details>
<summary><h3 style="display: inline;">AI</h3></summary>

In general, there was AI usage for this project, however the majority of it was used to debug code after already having spent a lot of time on it. There was also quite a bit of code refinement and comments being added, done by AI. Occasionally, such as with the local geocoding, the feature would be started with AI help then mostly done by hand.

</details>

### <center> Made with <3 by @kus001, @roc-ket-cod-er and @BigBrain244466666 </center>