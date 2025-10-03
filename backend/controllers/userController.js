const validator = require('validator');
const bcrypt = require('bcrypt');
const userModel = require('../models/UserModel');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary');
const doctorModel = require('../models/DoctorModel')
const appoinmentModel = require('../models/AppoinmentModel')
const razorpay = require('razorpay')
const crypto = require("crypto");

const registerUser = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.json({ success: false, message: "Missing details" });
    }

    if (!validator.isEmail(email)) {
      return res.json({ success: false, message: "Enter valid email" });
    }

    if (password.length < 8) {
      return res.json({ success: false, message: "Enter strong password" });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const userData = { name, email, password: hashedPassword };
    const newUser = new userModel(userData);
    const user = await newUser.save();

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ success: true, token });
  } catch (error) {
    console.error(error);
    res.json({ success: false, message: error.message });
  }
};


const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await userModel.findOne({ email });

    if (!user) {
      return res.json({ success: false, message: "User does not exist" });
    }

    const isMatched = await bcrypt.compare(password, user.password);

    if (isMatched) {
      const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
      res.json({ success: true, token });
    } else {
      return res.json({ success: false, message: "Invalid credentials" });
    }

  } catch (error) {
    console.error(error);
    res.json({ success: false, message: error.message });
  }
};


const getProfileData = async (req, res) => {
  try {
    const userId = req.userId;
    const userData = await userModel.findById(userId).select('-password');

    res.json({ success: true, userData });
  } catch (error) {
    console.error(error);
    res.json({ success: false, message: error.message });
  }
};


const updateProfile = async (req, res) => {
  try {
    const userId = req.userId;
    const { name, phone, address, dob, gender } = req.body;
    const imageFile = req.file;

    if (!name || !phone || !address || !dob || !gender) {
      return res.json({ success: false, message: 'Data missing' });
    }

    await userModel.findByIdAndUpdate(userId, {
      name,
      phone,
      address: JSON.parse(address),
      dob,
      gender,
    });


    if (imageFile) {
      const uploadResponse = await cloudinary.v2.uploader.upload(imageFile.path, {
        resource_type: 'image',
      });

      const imageUrl = uploadResponse.secure_url;
      await userModel.findByIdAndUpdate(userId, { image: imageUrl });
    }

    res.json({ success: true, message: "Profile has been updated" });
  } catch (error) {
    console.error(error);
    res.json({ success: false, message: error.message });
  }
};
// Api to book appoinment

const bookAppoinment = async(req,res) =>{
  try {
        const { docId, slotTime, slotDate } = req.body;
        const userId = req.userId;
        const doctorData = await doctorModel.findById(docId).select('-password')

        if(!doctorData.available){
            return res.json({success:false,message:"Doctor not available"})
        }

        let slotsBooked = doctorData.slotsBooked || {};

        //Checking for slot availability
        if(slotsBooked[slotDate]){
          if(slotsBooked[slotDate].includes(slotTime)){
            return res.json({success:false,message:"Slot not available"})
          }else{
            slotsBooked[slotDate].push(slotTime)
          }
        }else{
          slotsBooked[slotDate] = []
          slotsBooked[slotDate].push(slotTime)
        }
        const userData = await userModel.findById(userId).select('-password')

        delete doctorData.slotsBooked; 

        const appoinmentData = {
          userId,
          docId,
          userData,
          doctorData: doctorData.toObject(),
          amount:doctorData.fees,
          slotTime: slotTime, 
          slotDate,
          date: Date.now()
        }
        const newAppoinment = new appoinmentModel(appoinmentData)
        await newAppoinment.save()

        await doctorModel.findByIdAndUpdate(docId,{slotsBooked})
        res.json({success:true,message:"Appoinment has been booked"})
  } catch (error) {
    console.error(error);
    res.json({ success: false, message: error.message });
  }
}

const listAppoinment = async (req,res) =>{
        try {
            const userId = req.userId;
            const appoinment = await appoinmentModel.find({userId})
            res.json({success:true,appoinment})
        } catch (error) {
          console.error(error);
          res.json({ success: false, message: error.message });
        }
}
//Cancel Appoinment 

const cancelAppoinment = async (req, res) => {
  try {
    const { appoinmentId } = req.body;
    const userId = req.userId;

    if (!appoinmentId) {
      return res.status(400).json({ success: false, message: "Appointment ID is required" });
    }

    const appoinmentData = await appoinmentModel.findById(appoinmentId);
    if (!appoinmentData) {
      return res.status(404).json({ success: false, message: "Appointment not found" });
    }

    if (appoinmentData.userId.toString() !== userId.toString()) {
      return res.status(403).json({ success: false, message: "Unauthorized action" });
    }

    // Mark appointment as cancelled
    await appoinmentModel.findByIdAndUpdate(appoinmentId, { cancelled: true });

    // Release doctor's slot
    const { docId, slotDate, slotTime } = appoinmentData;
    const doctorData = await doctorModel.findById(docId);
    let slotsBooked = doctorData.slotsBooked || {};

    if (slotsBooked[slotDate]) {
      slotsBooked[slotDate] = slotsBooked[slotDate].filter((e) => e !== slotTime);
      await doctorModel.findByIdAndUpdate(docId, { slotsBooked });
    }

    return res.json({ success: true, message: "Appointment Cancelled" });

  } catch (error) {
    console.error("Cancel Appointment Error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};
//Payment Api
const razorpayInstance = new razorpay({
  key_id:process.env.RAZOR_PAY_ID,
  key_secret:process.env.RAZOR_PAY_SCERECT,
})
const razorpayPayment = async (req,res)=>{

      try {
        const { appoinmentId } = req.body;

        const appoinmentData = await appoinmentModel.findById(appoinmentId)
        if(!appoinmentData || appoinmentData.cancelled){
          return res.json({success:false,message:"Appoinment cancelled or not a found"})
        }
        const options = {
          amount:appoinmentData.amount * 100,
          currency:process.env.CURRENCY,
          receipt:appoinmentId
        }
        // create order
        const order = await razorpayInstance.orders.create(options)
        res.json({success:true,order})
      } catch (error) {
        console.error("Cancel Appointment Error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
      }
}

// API to verify payment of razorpay

const verifyPayment = async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;

    const order = await razorpayInstance.orders.fetch(razorpay_order_id);
    const appointmentId = order.receipt;

    const updatedAppointment = await appoinmentModel.findByIdAndUpdate(
      appointmentId,
      { payment: true },
      { new: true }
    );

    return res.json({ success: true, message: "Payment successful", appointment: updatedAppointment });

  } catch (error) {
    console.error("Verify Payment Error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

module.exports = {registerUser,loginUser,getProfileData,updateProfile,bookAppoinment,listAppoinment,cancelAppoinment,razorpayPayment,verifyPayment};
