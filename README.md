<h1 align="center"><a href=https://map.kmaps.ca> kmaps </a></h1>

<div align="center">

#### [kmaps](https://map.kmaps.ca/) is a student-made open source routing software, and it's still under development. All feedback is always welcome. Feel free to send it to [devs@kmaps.ca](mailto:devs@kmaps.ca)

<!-- street -->
<details>
  <summary>Street View</summary>

| Dark Mode | Light Mode |
|:---:|:---:|
| ![Street 2D Dark](assets/darkmode.png) | ![Street 2D Light](assets/lightmode.png) |
| ![Street 3D Dark](assets/street_3d_dark.png) | ![Street 3D Light](assets/street_3d_light.png) |
| ![Street globe dark](assets/street_globe_dark.png) | ![Street globe light](assets/street_globe_light.png) |

</details>

<!-- satellite -->
<details>
  <summary>Satellite View</summary>

| Dark Mode | Light Mode |
|:---:|:---:|
| ![Satellite 2D Dark](assets/dark_sat.png) | ![Satellite 2D Light](assets/light_sat.png) |
| ![Satellite 3D Dark](assets/satellite_3d_dark.png) | ![Satellite 3D Light](assets/satellite_3d_light.png) |
| ![Satellite Globe Dark](assets/satellite_globe_dark.png) | ![Satellite Globe Light](assets/satellite_globe_light.png) |

</details>

<!-- hybrid -->
<details>
  <summary>Hybrid View</summary>

| Dark Mode | Light Mode |
|:---:|:---:|
| ![Hybrid 2D Dark](assets/hybrid_dark.png) | ![Hybrid 2D Light](assets/hybrid_light.png) |
| ![Hybrid 3D Dark](assets/hybrid_3d_dark.png) | ![Hybrid 3D Light](assets/hybrid_3d_light.png) |
| ![Hybrid globe dark](assets/hybrid_globe_dark.png) | ![Hybrid globe light](assets/hybrid_globe_light.png) |

</details>

## Running / Using [kmaps](https://map.kmaps.ca/)

<h4><strong> <a href=https://map.kmaps.ca> kmaps </a> is now hosted at <a href=https://map.kmaps.ca> https://map.kmaps.ca </a></strong></h4>

</div>

If you'd rather compile it and run it yourself, locally, that too is quite simple, however it does prerequisite `vite` and `npm`. If you don't have them installed, now's a great time to get them.

In fact, kmaps is designed to be able to run fully offline for transit routing! (Alas, some features such as real time GTFS would not be possible). The local A* algorithm will work normally and do its routing job! However, if the address is not in the Region Of Waterloo's Address Lookup, then you will have to put the location into `transit_data/geocode_cache.json`. (Only for offline operation, as the geocoding falls back to online servers otherwise.)

To run [kmaps](https://map.kmaps.ca/) locally, follow the following (quite simple) steps!

1. **Optional:** Fork [the kmaps repository](https://github.com/kus001/map). Forking the repository creates your own version of the files, allowing you to modify and edit the open source files however you so desire, and also the ability to share your own version! Forking also allows you to make pull requests, which are a way of contributing back to the main repository. By doing so you help make open source software even better!

2. Next, **clone the repository**. Cloning the newly made repository permits you to have your own version of [our repository](https://github.com/kus001/map) downloaded locally onto your computer! Please note that where you type the following in will be where the new folder is made.

   - If you forked the repository first, run `git clone <your-repository-url>`.
   - If you did *not* fork [our repository](https://github.com/kus001/map),
all you have to do is **run the following** `git clone https://github.com/kus001/map`

3. Next, you must change your [working directory](https://en.wikipedia.org/wiki/Working_directory) to the one in which you cloned/downloaded the files. This is the one that we can't really help you with, but it will be wherever you ran the previous command. 

    - For example on windows if you ran this in `C:\Users\YourName\Documents\Github`, then you'll likely want to run `cd C:\Users\YourName\Documents\Github\map`

4. Next, once you are into your local version of your repo, run `cd frontend && npm install`. The first part will move you into the frontend repo where all the website code resides, while the second part will install the dependancies of the code.

6. After that, you'll want to run the project via `npm run dev`. You can run `npm run dev -- --host` to make it discoverable to other computers on the network!

7. For the python script, you should install its dependancies by running `pip install -r requirements.txt` in the base folder (typically `map/`) (in a new terminal)

8. Finally, make sure you run `python3 main.py` or else your server will not function! The server uses ports 8080 and 5173.

9. That's it! If you'd like to host your own server, keep reading. Please note that this has only been tested on linux.

    1. Build: build the website by running `npm run build` in the `frontend` directory.

    2. Install PM2: `npm install pm2@latest -g`. PM2 allows you to host the server even when you have closed the terminal!
    
    3. Still in the `frontend` directory, run `pm2 start ecosystem.config.cjs --env production`. This will cause the server to run on port `:5173`.

    4. To keep the python script running in the background, run `nohup python3 main.py > output.log 2>&1 &` in the base directory where `main.py` resides.

    5. If you want to reload your server with our latest code, just run `chmod +x rebuild.sh` to give rebuild.sh perms, and then run `./rebuild.sh`. If you'd rather do it yourself, follow the following. Start in the base directory for this git repo. In this case, that's going to be `map/`. We assume that this is already running, and you just want to rebuild with the latest code. It will also be assumed that the amount of RAM available is very limited. If that is not the case, ignore steps 1 and 2.

        1. Run `top -o %MEM`. This will allow you to find the `python3` process running, to kill it and provide enough RAM for the building.

        ![](assets/image3.png)

        2. In this case, you want to kill `14682`. Do this by running `kill 14682`.

        3. After that, pull the new code with `git pull`. If this fails, you will likely have to fix up `frontent/geocode_cache.json`, as it may have populated with things as your server has run. If you are ok with getting rid of any local changes, then you can just run `git restore transit_data/geocode_cache.json && git pull`

        4. Next, you'd like to build and redeploy the code. Do this by running `cd frontend/ && npm run build && pm2 restart all && cd ..`

        5. Restart `main.py` by running `nohup python3 main.py > output.log 2>&1 &`.

        6. **If you'd like a one liner:** Just run `git restore transit_data/geocode_cache.json || git pull && git pull && cd frontend/ && npm run build && pm2 restart all && cd ..`.
            - If you stopped `main.py` earlier, also run `nohup python3 main.py > output.log 2>&1 &` in the base folder. Note that this will destroy your local cache of places.

            - If PM2 wasn't already started, then just run `cd frontend/ && pm2 start ecosystem.config.cjs --env production && cd ..` first.

<div align="center">

## NOTES

</div>

<details>
<summary><h3 style="display: inline;">AI</h3></summary>

In general, there was AI usage for this project, however the majority of it was used to debug code after already having spent a lot of time on it. There was also quite a bit of code refinement and comments being added, done by AI. Occasionally, such as with the local geocoding, the feature would be started with AI help then mostly done by hand.

</details>

<details>
<summary><h3 style="display: inline;">Transit Agencies</h3></summary>

If you would like to add your own transit agencies, it should be really quite easy. `In transit/agencies.py` there is a dictionary titled `AGENCIES` (Around line 64) and it has all the agencies the router is configured for. You can easily add your own agencies from just their links, and then running `python -m transit.agency_setup [agency id]`. You can also put `all` in place of `[agency id]` to set up all new agencies! Setting up an agency involved downloading all the required files, compacting them into a `.pkl` and then setting them up and processing them.

</details>

<details>
<summary><h3 style="display: inline;">Walking links</h3></summary>

If you would like to have the option to walk between two seperate stops, you have the option to run python -m transit.walk_links to setup walking links between stops. Our server implementation is very, very slow, and thus we recommend that you set up your own OSRM routed server if possible. It takes our server about a minute per thousand links, and the setup stuff as of now (you can check our configs in `walk_links.py`'s `.config` import) had about 26,000 links to make, resulting in a very, very long runtime. And all of this was with a maximum walk distance of just 250m.

It should also be noted that the walking distance that is set will have an exponential impact on routing speed, seeing as the amount of edges that the A* algorithm will explore will go up exponentially as well. Its a trade off of routing time versus absolute best route. Since the trade off is exponential, we settled on 250 meters, but we acknowledge that in big cities it might slow down a lot. If the main purpose of your router is in-city routing, and the occasional long distance run can be slowed down, consider increasing the max travel times.

</details>

<div align="center">

### $$\color{red}\text{Made with <3 by @kus001, @roc-ket-cod-er and @BigBrain244466666}$$

</div>
