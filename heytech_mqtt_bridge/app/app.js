const config = require('/config');
const MqttHandler = require('./modules/MqttHandler.js');

const Heytech = require('./modules/heytech.js')({
    "config":config.get("Heytech")
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
    "config": config.get("MQTT"),
    "handler": Heytech
});


mqttHandler.connect();
//Heytech.connect();
