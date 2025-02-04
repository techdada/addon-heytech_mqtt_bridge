const config = require('/config');
const MqttHandler = require('./modules/MqttHandler.js');

const Heytech = require('./modules/heytech.js')({
    "config":{
        "host": process.env.heyhost,
        "port": process.env.heyport,
        "pin": process.env.heypin
    }
});


    /*"rolladen": {
      "Schafzimmer": "1",
      "Schlafzimmer": "2",
      "Suedfluegel": "3",
      "Wohnzimmer S": "4",
      "Wohnzimmer N": "5",
      "Gaeste": "9",
      "Bad L+M": "10",
      "Bad R": "11",
      "Buero": "12",
      "HWR": "13"
    },
    "rolladengroup": {
      "Bad": {
        "Bad L+M": "10",
        "Bad R": "11"
      }
    }*/

let mqttHandler = new MqttHandler({
    "config": {
        "host": process.env.mqtthost,
        "port": process.env.mqttport,
        "user": process.env.mqttuser,
        "pass": process.env.mqttpass,
        "cafile": process.env.cafile,
        "control_topic_root": process.env.control_topic_root,
        "state_topic_root": process.env.state_topic_root
    },
    "handler": Heytech
});


mqttHandler.connect();
//Heytech.connect();
